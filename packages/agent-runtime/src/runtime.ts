import { randomUUID } from "node:crypto";
import { getHarnessAdapter } from "./harnesses/index.js";
import { createSandboxProvider } from "./sandbox/index.js";
import { CreateAgentSessionConfigSchema } from "./schemas.js";
import { RuntimeAgentSession } from "./session.js";
import type {
	AgentSession,
	CreateAgentSessionConfig,
	HarnessKind,
	NormalizedAgentSessionConfig,
	RuntimeCallbacks,
	RuntimeHarnessConfig,
	RuntimeSecret,
	SandboxProvider,
} from "./types.js";

export interface CreateAgentRuntimeOptions<
	H extends HarnessKind = HarnessKind,
> {
	callbacks?: RuntimeCallbacks<H>;
	sandboxProviders?: Record<string, SandboxProvider>;
}

/**
 * Variant of `CreateAgentSessionConfig` whose `harness` field is
 * narrowed to a single `HarnessKind`, so `createAgentSession` can
 * infer `H` from the config the caller wrote.
 */
export type CreateAgentSessionConfigFor<H extends HarnessKind> = Omit<
	CreateAgentSessionConfig,
	"harness"
> & {
	harness: H | (RuntimeHarnessConfig & { kind: H });
};

export class AgentRuntime<H extends HarnessKind = HarnessKind> {
	constructor(private readonly options: CreateAgentRuntimeOptions<H> = {}) {}

	async createSession(
		config: CreateAgentSessionConfigFor<H>,
	): Promise<AgentSession<H>> {
		const normalized = normalizeConfig(config);
		const adapter = getHarnessAdapter(normalized.harness.kind);
		const provider =
			this.options.sandboxProviders?.[normalized.sandbox.provider] ??
			createSandboxProvider(normalized.sandbox.provider);
		const sandbox = await provider.create(normalized.sandbox);
		// Internal RuntimeAgentSession is non-generic (it operates on the
		// loose union); narrow the public return via cast at this boundary
		// so callers get the typed handle without the implementation
		// having to thread the generic everywhere.
		return new RuntimeAgentSession(
			normalized,
			adapter,
			sandbox,
			this.options
				.callbacks as RuntimeCallbacks /* widen to default for impl */,
		) as unknown as AgentSession<H>;
	}
}

export function createAgentRuntime<H extends HarnessKind = HarnessKind>(
	options?: CreateAgentRuntimeOptions<H>,
): AgentRuntime<H> {
	return new AgentRuntime(options);
}

export async function createAgentSession<H extends HarnessKind = HarnessKind>(
	config: CreateAgentSessionConfigFor<H>,
	options?: CreateAgentRuntimeOptions<H>,
): Promise<AgentSession<H>> {
	return createAgentRuntime<H>(options).createSession(config);
}

export function normalizeConfig(
	config: CreateAgentSessionConfig,
): NormalizedAgentSessionConfig {
	const parsed = CreateAgentSessionConfigSchema.parse(
		config,
	) as CreateAgentSessionConfig;
	const harness = normalizeHarness(parsed.harness, parsed.model);
	const secrets = normalizeSecrets(parsed.secrets ?? {});
	return {
		...parsed,
		sessionId: parsed.sessionId ?? randomUUID(),
		harness,
		model: harness.model ?? parsed.model,
		env: parsed.env ?? {},
		secrets,
		sandbox: parsed.sandbox ?? {
			provider: "local",
			workingDirectory: process.cwd(),
		},
	};
}

function normalizeHarness(
	harness: CreateAgentSessionConfig["harness"],
	model?: string,
): RuntimeHarnessConfig {
	if (typeof harness === "string") {
		return { kind: harness, model };
	}
	return {
		...harness,
		model: harness.model ?? model,
	};
}

function normalizeSecrets(
	secrets: Record<string, RuntimeSecret | string>,
): Record<string, RuntimeSecret> {
	return Object.fromEntries(
		Object.entries(secrets).map(([key, secret]) => [
			key,
			typeof secret === "string" ? { value: secret, redact: true } : secret,
		]),
	);
}
