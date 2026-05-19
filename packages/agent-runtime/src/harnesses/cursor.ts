import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@cursor/sdk";
import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

/**
 * Absolute path to the vendored cursor driver script.
 *
 * Built from `src/harnesses/cursor-driver.ts` → `dist/harnesses/cursor-driver.js`,
 * sibling to this file in both source and dist layouts. Resolved via
 * `import.meta.url` so it works whether the runtime is consumed directly
 * from `dist/` or via a pnpm workspace symlink.
 */
const CURSOR_DRIVER_PATH = fileURLToPath(
	new URL("./cursor-driver.js", import.meta.url),
);

export const cursorHarness: HarnessAdapter = {
	kind: "cursor",
	// Cursor's SDK does support agent resume via `Agent.resume(agentId)`,
	// but the agentId lives in our driver's process state, not in a
	// filesystem state directory — we persist it via `--agent-id-file`
	// (a sibling of the session's state backing). No HOME-relative
	// directory to declare here.
	stateDirectories: [],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		// We spawn `node <driver>` instead of `cursor-agent` so the wire
		// format matches `@cursor/sdk`'s `SDKMessage` union by
		// construction. See cursor-driver.ts for the why.
		const args = [CURSOR_DRIVER_PATH, "--prompt", options.userPrompt];

		const model = resolveModel(config);
		if (model) {
			args.push("--model", model);
		}

		// Working directory inside the sandbox — Cursor's local-agent
		// mode needs an explicit cwd so it knows where to walk file
		// contexts from.
		if (config.sandbox?.workingDirectory) {
			args.push("--cwd", config.sandbox.workingDirectory);
		}

		// systemPrompt is prepended to the user prompt by the driver
		// (Cursor doesn't expose a separate system-instructions field
		// at the local-agent layer the way Claude does).
		if (config.systemPrompt && !options.continueSession) {
			args.push("--system-prompt", config.systemPrompt);
		}

		// Cross-turn resume: the agentId is written to
		// `<sessionStateRoot>/cursor-agent-id` on first turn and passed
		// back as `--agent-id` on subsequent turns. The runtime's
		// per-session state backing owns the file; the harness adapter
		// just declares its name.
		//
		// TODO: thread the actual state-backing path through HarnessRunOptions
		// so we can produce a real `--agent-id-file` value here. For now the
		// driver runs without resume — works for single-turn chat, breaks for
		// multi-turn Slack threads on Cursor. The chat handler is Claude-only
		// today (per AgentChatSessionHandler's docstring) so this gap doesn't
		// regress anything that ships.

		return createCommand(config, "node", args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("cursor", line, context);
	},
	extractResult(events) {
		// Walk backwards for the last assistant text block. The driver
		// emits `SDKMessage` directly, so `event.raw.type === "assistant"`
		// narrows to `SDKAssistantMessage` with full content typing —
		// no manual guards.
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const event = events[i];
			if (!event) continue;
			const raw = event.raw as SDKMessage | undefined;
			if (raw?.type !== "assistant") continue;
			for (const block of raw.message.content) {
				if (block.type === "text" && typeof block.text === "string") {
					return block.text;
				}
			}
		}
		return undefined;
	},
};
