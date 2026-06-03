import type {
	HookCallbackMatcher,
	HookEvent,
	HookJSONOutput,
	PostToolUseFailureHookInput,
} from "cyrus-claude-runner";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import type { ILogger } from "cyrus-core";
import {
	extractProgramName,
	OOM_MARKER,
	parseOomMarker,
	unwrapCommand,
} from "./cyrus-tool-exec.js";

/** Exit code of an OOM-killed process (128 + SIGKILL/9). */
const OOM_EXIT_CODE = 137;

/**
 * A per-command OOM event, ready to report to the control plane. Mirrors the
 * wire shape accepted by `POST /api/oom-event` (CYHOST-1012). `team_id`,
 * `droplet_id`, and `tier` are intentionally absent — the endpoint derives them
 * server-side from the droplet's bearer key.
 */
export interface OomEvent {
	/**
	 * The **entire** command that was OOM-killed, unwrapped (wrapper prefix
	 * stripped) and **untruncated**. This is what makes a report actionable —
	 * an earlier program-only excerpt logged `cd` for
	 * `cd …/rust-analyzer && cargo build`, which is useless for debugging.
	 */
	command: string;
	/**
	 * Best-effort program basename for aggregation (e.g. `cargo`), with leading
	 * `cd …`, env assignments, and exec wrappers stripped. See
	 * {@link extractProgramName}.
	 */
	program: string;
	budgetMb?: number;
	peakBytes?: number;
	/** Process exit code — always {@link OOM_EXIT_CODE} for an OOM kill. */
	exitCode?: number;
	/** OOM-kill count parsed from the marker, when the wrapper emits it. */
	oomKillCount?: number;
	/** Cyrus agent-session id. */
	sessionId?: string;
	/** Originating platform, e.g. `"linear"`. */
	sessionSource?: string;
	/** Underlying runner session id (e.g. the Claude session id), if assigned. */
	runnerSessionId?: string;
	/** Runner type, e.g. `"claude"`. */
	runnerType?: string;
	/** Model in use, e.g. `"claude-opus-4-8"`. */
	model?: string;
	/** Customer Linear issue id. */
	linearIssueId?: string;
	/** Customer Linear issue identifier, e.g. `"CYPACK-1274"`. */
	linearIssueIdentifier?: string;
	/** Customer Linear issue URL. */
	linearIssueUrl?: string;
	/** Session worktree path on the droplet. */
	workspacePath?: string;
}

/**
 * Static session/issue/runner context available when the hook is built. Threaded
 * in by {@link RunnerConfigBuilder} so each OOM report carries which session,
 * issue, runner, and model produced it.
 *
 * `getRunnerSessionId` is a **getter**, not a value: the runner session id
 * (Claude session id) isn't known until the SDK emits `claude_session_id_assigned`
 * — well after the hook is constructed — so it must be read lazily at report time.
 */
export interface OomReportContext {
	sessionId?: string;
	sessionSource?: string;
	runnerType?: string;
	model?: string;
	workspacePath?: string;
	linearIssueId?: string;
	linearIssueIdentifier?: string;
	linearIssueUrl?: string;
	getRunnerSessionId?: () => string | undefined;
	/**
	 * Invoked once per detected OOM, before the (best-effort) telemetry report.
	 * Lets the caller record that this session hit its memory budget so a
	 * user-facing notice can be surfaced later — independent of whether the
	 * telemetry POST succeeds.
	 */
	onOom?: () => void;
}

/**
 * Transport seam for delivering {@link OomEvent}s. Abstracting it (rather than
 * calling `fetch` inline) keeps the hook responsible only for *detecting and
 * parsing* OOMs, and lets the transport be swapped or stubbed independently —
 * mirroring the `PrMarkerProvider` / `IntentToAddGitClient` seams used by the
 * sibling hooks.
 */
export interface OomEventReporter {
	/** Deliver one event. Implementations must never throw — telemetry fails open. */
	report(event: OomEvent): Promise<void>;
}

/** Options for {@link HttpOomEventReporter}. */
export interface HttpOomEventReporterOptions {
	/** Reads an environment variable. Defaults to `process.env`. */
	getEnv?: (name: string) => string | undefined;
	/** Resolves the cyrus-hosted control-plane base URL. Defaults to `getCyrusAppUrl`. */
	getBaseUrl?: () => string;
	/** Fetch implementation. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Network timeout in ms. Defaults to 5s — OOM is rare, so a short await is fine. */
	timeoutMs?: number;
}

/**
 * Default {@link OomEventReporter}: `POST`s to `<cyrus-app-url>/api/oom-event`
 * authenticated with the droplet's `CYRUS_API_KEY` bearer — the same
 * control-plane callback path failure-mode reporting already uses. A missing
 * key is a silent no-op (community/self-host with no control plane). Every
 * failure mode is swallowed so a report can never block or fail a tool result.
 */
export class HttpOomEventReporter implements OomEventReporter {
	private readonly getEnv: (name: string) => string | undefined;
	private readonly getBaseUrl: () => string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(
		private readonly log: ILogger,
		options: HttpOomEventReporterOptions = {},
	) {
		this.getEnv = options.getEnv ?? ((name: string) => process.env[name]);
		this.getBaseUrl = options.getBaseUrl ?? getCyrusAppUrl;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 5_000;
	}

	async report(event: OomEvent): Promise<void> {
		const apiKey = this.getEnv("CYRUS_API_KEY")?.trim();
		if (!apiKey) {
			return;
		}

		const url = `${this.getBaseUrl().replace(/\/+$/, "")}/api/oom-event`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					command: event.command,
					program: event.program,
					budgetMb: event.budgetMb,
					peakBytes: event.peakBytes,
					exitCode: event.exitCode,
					oomKillCount: event.oomKillCount,
					sessionId: event.sessionId,
					sessionSource: event.sessionSource,
					runnerSessionId: event.runnerSessionId,
					runnerType: event.runnerType,
					model: event.model,
					linearIssueId: event.linearIssueId,
					linearIssueIdentifier: event.linearIssueIdentifier,
					linearIssueUrl: event.linearIssueUrl,
					workspacePath: event.workspacePath,
				}),
				signal: controller.signal,
			});
			if (!res.ok) {
				this.log.debug(`[OomReportHook] /api/oom-event returned ${res.status}`);
			} else {
				this.log.info(
					`[OomReportHook] reported OOM (program=${event.program} budget=${event.budgetMb}M peak=${event.peakBytes}B)`,
				);
			}
		} catch (err) {
			this.log.debug(`[OomReportHook] failing open: ${(err as Error).message}`);
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Collapse a failed Bash result into a single searchable string. Handles the
 * `error: string` carried by `PostToolUseFailureHookInput`, a raw string, or a
 * `{ stdout, stderr, ... }`-shaped object, falling back to JSON for unexpected
 * shapes so the marker substring check still works.
 */
export function extractResultText(toolResponse: unknown): string {
	if (typeof toolResponse === "string") {
		return toolResponse;
	}
	if (toolResponse && typeof toolResponse === "object") {
		const parts: string[] = [];
		for (const value of Object.values(
			toolResponse as Record<string, unknown>,
		)) {
			if (typeof value === "string") {
				parts.push(value);
			}
		}
		if (parts.length > 0) {
			return parts.join("\n");
		}
		try {
			return JSON.stringify(toolResponse);
		} catch {
			return "";
		}
	}
	return "";
}

/**
 * The user-facing notice appended to a session's final result when one of its
 * Bash commands was OOM-killed. Kept concise and on-brand (atcyrus.com voice:
 * speed/shipping-first, second person), and it states the *why* — more compute
 * means heavy builds/installs/test suites run to completion instead of stalling.
 * `billingUrl` is the cyrus-hosted billing page where compute can be upgraded.
 */
export function buildMemoryLimitNotice(billingUrl: string): string {
	return (
		"> ⚠️ **A command was stopped for exceeding your plan's memory budget.** " +
		"More compute lets heavy builds, installs, and test suites finish in one " +
		"pass — fewer stalls, more shipped. " +
		`[Upgrade your plan →](${billingUrl})`
	);
}

/**
 * Build the hook that reports per-command OOM kills to the cyrus-hosted control
 * plane. It registers on **`PostToolUseFailure`**, not `PostToolUse`: an
 * OOM-killed command exits non-zero, so the SDK routes its result to the
 * failure event — the {@link OOM_MARKER} can therefore never appear in a
 * (successful) `PostToolUse` result. The hook's sole responsibility is to
 * detect the marker, parse it, enrich it with the injected {@link
 * OomReportContext}, and hand a structured {@link OomEvent} to the injected
 * {@link OomEventReporter} — delivery details (auth, URL, timeout, fail-open)
 * live in the reporter.
 *
 * On `PostToolUseFailure` the failure detail lives in `error` (a string). We
 * also fold in any `tool_response` if a future SDK surfaces one, so the marker
 * is found regardless of which field carries it.
 */
export function buildOomReportHook(
	log: ILogger,
	reporter: OomEventReporter = new HttpOomEventReporter(log),
	context: OomReportContext = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		PostToolUseFailure: [
			{
				matcher: "Bash",
				hooks: [
					async (input): Promise<HookJSONOutput> => {
						try {
							const post = input as PostToolUseFailureHookInput & {
								tool_response?: unknown;
							};
							const text = `${extractResultText(post.error)}\n${extractResultText(
								post.tool_response,
							)}`;
							if (!text.includes(OOM_MARKER)) {
								return {};
							}

							// Record the OOM first, so a user-facing notice can be
							// surfaced even if the telemetry POST below fails.
							context.onOom?.();

							const { budgetMb, peakBytes, oomKillCount } =
								parseOomMarker(text);
							const rawCommand =
								(post.tool_input as { command?: unknown } | undefined)
									?.command ?? "";
							const command = typeof rawCommand === "string" ? rawCommand : "";
							await reporter.report({
								// Full original command, wrapper stripped, untruncated.
								command: unwrapCommand(command),
								program: extractProgramName(command),
								budgetMb,
								peakBytes,
								exitCode: OOM_EXIT_CODE,
								oomKillCount,
								sessionId: context.sessionId,
								sessionSource: context.sessionSource,
								runnerSessionId: context.getRunnerSessionId?.(),
								runnerType: context.runnerType,
								model: context.model,
								linearIssueId: context.linearIssueId,
								linearIssueIdentifier: context.linearIssueIdentifier,
								linearIssueUrl: context.linearIssueUrl,
								workspacePath: context.workspacePath,
							});
						} catch (err) {
							log.debug(
								`[OomReportHook] failing open: ${(err as Error).message}`,
							);
						}
						return {};
					},
				],
			},
		],
	};
}
