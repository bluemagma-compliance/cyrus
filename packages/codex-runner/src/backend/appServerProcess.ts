import {
	AppServerClient,
	type AppServerClientFactory,
	type IAppServerClient,
} from "./appServerClient.js";
import { resolveCodexAppServerLaunch } from "./codexBinary.js";
import type { ResolvedCodexConfig } from "./types.js";

const CLIENT_INFO = { name: "cyrus-codex-runner", version: "1.0.0" };
const DEFAULT_IDLE_CLOSE_MS = 30_000;

export interface AppServerThreadHandler {
	onNotification(method: string, params: unknown): void;
	onProcessGone(): void;
	onProcessError(error: unknown): void;
}

export interface AppServerProcessLease {
	request<T = unknown>(method: string, params: unknown): Promise<T>;
	registerThread(threadId: string, handler: AppServerThreadHandler): void;
	unregisterThread(threadId: string, handler: AppServerThreadHandler): void;
	release(): void;
}

interface AppServerProcessManagerOptions {
	requestTimeoutMs?: number;
	idleCloseMs?: number;
}

interface LaunchOptions {
	command: string;
	args: string[];
	env?: Record<string, string>;
	requestTimeoutMs?: number;
}

/**
 * Owns the single Codex app-server process for this Node process. Individual
 * CodexRunner instances acquire lightweight leases and open separate app-server
 * threads over the shared JSON-RPC connection.
 */
export class AppServerProcessManager {
	private client: IAppServerClient | null = null;
	private launchKey: string | null = null;
	private startPromise: Promise<void> | null = null;
	private leaseCount = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly threadHandlers = new Map<string, AppServerThreadHandler>();
	private readonly requestTimeoutMs: number | undefined;
	private readonly idleCloseMs: number;

	constructor(
		private readonly clientFactory: AppServerClientFactory = (options) =>
			new AppServerClient(options),
		options?: AppServerProcessManagerOptions,
	) {
		this.requestTimeoutMs = options?.requestTimeoutMs;
		this.idleCloseMs = options?.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
	}

	async acquire(config: ResolvedCodexConfig): Promise<AppServerProcessLease> {
		const { command, args } = resolveCodexAppServerLaunch(config.codexPath);
		const launchOptions: LaunchOptions = {
			command,
			args,
			...(config.env ? { env: config.env } : {}),
			...(this.requestTimeoutMs !== undefined
				? { requestTimeoutMs: this.requestTimeoutMs }
				: {}),
		};
		const launchKey = buildLaunchKey(launchOptions);

		if (this.launchKey && this.launchKey !== launchKey && this.leaseCount === 0) {
			await this.closeAll();
		}
		if (this.launchKey && this.launchKey !== launchKey) {
			throw new Error(
				"Cannot start Codex thread: shared app-server is already running with different launch options",
			);
		}

		this.leaseCount += 1;
		this.clearIdleTimer();

		let released = false;
		try {
			await this.ensureStarted(launchOptions, launchKey);
		} catch (error) {
			if (!released) {
				released = true;
				this.releaseRef();
			}
			throw error;
		}

		return {
			request: <T = unknown>(method: string, params: unknown): Promise<T> => {
				const client = this.client;
				if (!client) {
					return Promise.reject(
						new Error(`Cannot send ${method}: app-server is not running`),
					);
				}
				return client.request<T>(method, params);
			},
			registerThread: (threadId, handler) => {
				const existing = this.threadHandlers.get(threadId);
				if (existing && existing !== handler) {
					throw new Error(
						`Cannot register Codex thread ${threadId}: already registered`,
					);
				}
				this.threadHandlers.set(threadId, handler);
			},
			unregisterThread: (threadId, handler) => {
				if (this.threadHandlers.get(threadId) === handler) {
					this.threadHandlers.delete(threadId);
				}
			},
			release: () => {
				if (released) {
					return;
				}
				released = true;
				this.releaseRef();
			},
		};
	}

	async closeAll(): Promise<void> {
		this.clearIdleTimer();
		this.threadHandlers.clear();
		this.leaseCount = 0;
		this.launchKey = null;
		this.startPromise = null;
		const client = this.client;
		this.client = null;
		await client?.close();
	}

	private async ensureStarted(
		options: LaunchOptions,
		launchKey: string,
	): Promise<void> {
		if (this.client) {
			return;
		}
		if (this.startPromise) {
			await this.startPromise;
			return;
		}

		const client = this.clientFactory({
			binaryPath: options.command,
			args: options.args,
			...(options.env ? { env: options.env } : {}),
			...(options.requestTimeoutMs !== undefined
				? { requestTimeoutMs: options.requestTimeoutMs }
				: {}),
		});
		this.client = client;
		this.launchKey = launchKey;

		client.setNotificationHandler((method, params) =>
			this.routeNotification(method, params),
		);
		client.setServerRequestHandler((method) => this.onServerRequest(method));
		client.on("exit", () => this.onProcessGone());
		client.on("error", (error) => this.onProcessError(error));
		client.start();

		let startPromise: Promise<void>;
		startPromise = client
			.request("initialize", {
				clientInfo: CLIENT_INFO,
				capabilities: { experimentalApi: true },
			})
			.then(() => undefined)
			.catch((error) => {
				if (this.client === client) {
					this.client = null;
					this.launchKey = null;
					this.threadHandlers.clear();
				}
				throw error;
			})
			.finally(() => {
				if (this.startPromise === startPromise) {
					this.startPromise = null;
				}
			});
		this.startPromise = startPromise;
		await startPromise;
	}

	private routeNotification(method: string, params: unknown): void {
		const threadId = extractThreadId(params);
		if (!threadId) {
			return;
		}
		this.threadHandlers.get(threadId)?.onNotification(method, params);
	}

	private onServerRequest(method: string): unknown {
		// With approvalPolicy="never" the server should not ask for approvals;
		// respond defensively so a stray request can never wedge a turn.
		if (/auth/i.test(method)) {
			return { chatgptAuthToken: null };
		}
		if (/approval/i.test(method)) {
			return { decision: "accept" };
		}
		return {};
	}

	private onProcessGone(): void {
		const handlers = [...new Set(this.threadHandlers.values())];
		this.threadHandlers.clear();
		this.client = null;
		this.launchKey = null;
		this.startPromise = null;
		this.clearIdleTimer();
		for (const handler of handlers) {
			handler.onProcessGone();
		}
	}

	private onProcessError(error: unknown): void {
		for (const handler of new Set(this.threadHandlers.values())) {
			handler.onProcessError(error);
		}
	}

	private releaseRef(): void {
		this.leaseCount = Math.max(0, this.leaseCount - 1);
		if (this.leaseCount === 0) {
			this.scheduleIdleClose();
		}
	}

	private scheduleIdleClose(): void {
		this.clearIdleTimer();
		if (!this.client) {
			return;
		}
		if (this.idleCloseMs <= 0) {
			void this.closeAll();
			return;
		}
		this.idleTimer = setTimeout(() => {
			void this.closeAll();
		}, this.idleCloseMs);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
}

export const defaultAppServerProcessManager = new AppServerProcessManager();

function extractThreadId(params: unknown): string | undefined {
	if (!params || typeof params !== "object") {
		return undefined;
	}
	const p = params as {
		threadId?: unknown;
		thread?: { id?: unknown };
	};
	if (typeof p.threadId === "string") {
		return p.threadId;
	}
	return typeof p.thread?.id === "string" ? p.thread.id : undefined;
}

function buildLaunchKey(options: LaunchOptions): string {
	return JSON.stringify({
		command: options.command,
		args: options.args,
		env: options.env ? sortRecord(options.env) : null,
		requestTimeoutMs: options.requestTimeoutMs ?? null,
	});
}

function sortRecord(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
	);
}
