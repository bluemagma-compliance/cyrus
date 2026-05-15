import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	AgentSession,
	AgentSessionResult,
	TranscriptEvent,
} from "cyrus-agent-runtime";
import { createAgentSession } from "cyrus-agent-runtime";
import type { ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";

/**
 * Generic chat platform adapter for the agent-runtime-backed handler.
 *
 * NOTE: `postReply` here takes a plain string (the final assistant text
 * extracted by the harness adapter), not an `IAgentRunner`. This decouples
 * platform adapters from the runner machinery — they only need to know how
 * to convert agent output back into a platform message.
 */
export type ChatPlatformName = "slack" | "linear" | "github";

export interface ChatPlatformAdapter<TEvent> {
	readonly platformName: ChatPlatformName;
	extractTaskInstructions(event: TEvent): string;
	getThreadKey(event: TEvent): string;
	getEventId(event: TEvent): string;
	buildSystemPrompt(event: TEvent): string;
	fetchThreadContext(event: TEvent): Promise<string>;
	postReply(event: TEvent, finalText: string): Promise<void>;
	acknowledgeReceipt(event: TEvent): Promise<void>;
	notifyBusy(event: TEvent, threadKey: string): Promise<void>;
}

export interface AgentChatSessionHandlerDeps {
	cyrusHome: string;
	chatRepositoryProvider: ChatRepositoryProvider;
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onError: (error: Error) => void;
}

/**
 * Slim chat-session handler built on top of `cyrus-agent-runtime`'s
 * `createAgentSession`. Replaces the old `ChatSessionHandler` +
 * `IAgentRunner` + `AgentSessionManager` stack with a single call into the
 * unified agent runtime.
 *
 * Brutal cuts compared to `ChatSessionHandler` (deliberate, spike-only):
 *
 * - **No multi-turn `--continue` resume.** Each platform event spawns a
 *   fresh `AgentSession`. Conversation continuity comes from the
 *   adapter's `fetchThreadContext()` injecting the prior thread as text
 *   into the user prompt.
 * - **No mid-flight stream injection.** If a thread already has an
 *   in-flight session, the new message gets `notifyBusy()`. (Future
 *   work: route through `AgentSession.addMessage()` with
 *   `interactiveInput: true` for harnesses that consume stream-json
 *   stdin.)
 * - **No MCP servers.** `cyrus-agent-runtime` accepts an `mcps` field
 *   but doesn't yet wire them through to the harness CLI. In-process
 *   SDK servers (cyrus-tools) wouldn't translate across the subprocess
 *   boundary anyway. Slack chat sessions run with the Claude CLI's
 *   default toolset only.
 * - **Claude harness only.** The runner-selection layer is gone here —
 *   if the user wants Codex/Gemini for Slack chat, that's a follow-up.
 * - **No persisted session state.** No AgentSessionManager, no
 *   thread-to-claudeSessionId map. Each session is born and dies in
 *   one webhook turn.
 */
export class AgentChatSessionHandler<TEvent> {
	private readonly adapter: ChatPlatformAdapter<TEvent>;
	private readonly deps: AgentChatSessionHandlerDeps;
	private readonly logger: ILogger;
	private readonly threadSessions = new Map<string, AgentSession>();

	constructor(
		adapter: ChatPlatformAdapter<TEvent>,
		deps: AgentChatSessionHandlerDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger =
			logger ?? createLogger({ component: "AgentChatSessionHandler" });
	}

	/** Returns true if any thread on this handler has an in-flight session. */
	isAnyRunnerBusy(): boolean {
		return this.threadSessions.size > 0;
	}

	/** Test/inspection: enumerate active threads. */
	listThreads(): Array<{ threadKey: string; sessionId: string }> {
		return Array.from(this.threadSessions.entries()).map(
			([threadKey, session]) => ({ threadKey, sessionId: session.sessionId }),
		);
	}

	async handleEvent(event: TEvent): Promise<void> {
		this.deps.onWebhookStart();
		try {
			const eventId = this.adapter.getEventId(event);
			const threadKey = this.adapter.getThreadKey(event);
			this.logger.info(
				`Processing ${this.adapter.platformName} webhook: ${eventId} (thread ${threadKey})`,
			);

			// Fire-and-forget acknowledgement (e.g. emoji reaction)
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			// In-flight thread → notify and bail out. (Brutal cut: no mid-flight
			// stream injection — see header for why.)
			if (this.threadSessions.has(threadKey)) {
				this.logger.info(
					`Thread ${threadKey} has an active session; notifying user.`,
				);
				await this.adapter.notifyBusy(event, threadKey);
				return;
			}

			const taskInstructions = this.adapter.extractTaskInstructions(event);
			const threadContext = await this.adapter.fetchThreadContext(event);
			const userPrompt = threadContext
				? `${threadContext}\n\n${taskInstructions}`
				: taskInstructions;
			const systemPrompt = this.adapter.buildSystemPrompt(event);

			const workspace = await this.createWorkspace(threadKey);
			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${this.adapter.platformName} thread ${threadKey}`,
				);
				return;
			}

			const sessionId = `${this.adapter.platformName}-${eventId}`;
			this.logger.info(
				`Starting AgentSession ${sessionId} (workspace ${workspace})`,
			);

			const session = await createAgentSession(
				{
					sessionId,
					harness: { kind: "claude" },
					systemPrompt,
					userPrompt,
					sandbox: { provider: "local", workingDirectory: workspace },
				},
				{
					callbacks: {
						onTranscriptEvent: (te) => {
							this.logger.debug(`[${sessionId}] transcript event: ${te.kind}`);
						},
					},
				},
			);
			this.threadSessions.set(threadKey, session);

			let result: AgentSessionResult;
			try {
				result = await session.start();
			} finally {
				this.threadSessions.delete(threadKey);
			}

			if (!result.success) {
				this.logger.error(
					`Session ${sessionId} did not succeed (exitCode=${result.exitCode})`,
					result.error,
				);
				if (result.error) this.deps.onError(result.error);
				// Best-effort: post a brief failure note instead of leaving the user hanging.
				try {
					await this.adapter.postReply(
						event,
						result.error
							? `I hit an error: ${result.error.message}`
							: `I couldn't complete the request (exit code ${result.exitCode}).`,
					);
				} catch (postErr) {
					this.logger.error(
						`Failed to post failure notice for session ${sessionId}`,
						postErr instanceof Error ? postErr : new Error(String(postErr)),
					);
				}
				await result.destroy();
				return;
			}

			// Prefer the harness-extracted result string; fall back to scanning
			// transcript events for the last assistant text.
			const finalText =
				result.result ?? this.extractAssistantFallback(result.events);
			if (!finalText) {
				this.logger.warn(
					`Session ${sessionId} completed but produced no result text`,
				);
				await result.destroy();
				return;
			}

			try {
				await this.adapter.postReply(event, finalText);
				this.logger.info(`Posted reply for session ${sessionId}`);
			} catch (postErr) {
				this.logger.error(
					`Failed to post reply for session ${sessionId}`,
					postErr instanceof Error ? postErr : new Error(String(postErr)),
				);
			}

			await result.destroy();
		} catch (error) {
			this.logger.error(
				`Failed to process ${this.adapter.platformName} webhook`,
				error instanceof Error ? error : new Error(String(error)),
			);
			this.deps.onError(
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.onWebhookEnd();
		}
	}

	/**
	 * Stop all in-flight sessions and release their sandboxes. Used at
	 * EdgeWorker shutdown.
	 */
	async shutdown(): Promise<void> {
		const sessions = Array.from(this.threadSessions.values());
		this.threadSessions.clear();
		await Promise.all(
			sessions.map(async (session) => {
				try {
					await session.destroy();
				} catch (err) {
					this.logger.warn(
						`Failed to destroy session ${session.sessionId} during shutdown: ${err instanceof Error ? err.message : err}`,
					);
				}
			}),
		);
	}

	private async createWorkspace(threadKey: string): Promise<string | null> {
		try {
			const sanitizedKey = threadKey.replace(/[^a-zA-Z0-9.-]/g, "_");
			const workspacePath = join(
				this.deps.cyrusHome,
				`${this.adapter.platformName}-workspaces`,
				sanitizedKey,
			);
			await mkdir(workspacePath, { recursive: true });
			return workspacePath;
		} catch (error) {
			this.logger.error(
				`Failed to create ${this.adapter.platformName} workspace for thread ${threadKey}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Walk the transcript backwards looking for the last assistant text
	 * block. Used when the harness adapter's `extractResult()` returns
	 * undefined.
	 */
	private extractAssistantFallback(
		events: readonly TranscriptEvent[],
	): string | undefined {
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const e = events[i];
			if (!e) continue;
			const raw = e.raw as
				| {
						type?: string;
						message?: {
							content?: Array<{ type?: string; text?: string }>;
						};
				  }
				| undefined;
			if (raw?.type === "assistant" && raw.message?.content) {
				const block = raw.message.content.find(
					(b) => b.type === "text" && typeof b.text === "string",
				);
				if (block?.text) return block.text;
			}
		}
		return undefined;
	}
}
