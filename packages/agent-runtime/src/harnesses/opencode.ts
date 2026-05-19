import type {
	HarnessAdapter,
	HarnessRunOptions,
	NormalizedAgentSessionConfig,
} from "../types.js";
import { createCommand, parseJsonLine, resolveModel } from "./common.js";

export const opencodeHarness: HarnessAdapter = {
	kind: "opencode",
	stateDirectories: [],
	buildCommand(
		config: NormalizedAgentSessionConfig,
		options: HarnessRunOptions,
	) {
		// `--format json` (not `--output-format json`) — the CLI's actual flag
		// per `opencode run --help` on v1.15.5. Mis-named in earlier versions
		// of this adapter; would have failed at runtime on first invocation.
		const args = ["run", "--format", "json"];
		const model = resolveModel(config);

		if (model) {
			args.push("--model", model);
		}

		if (config.systemPrompt && !options.continueSession) {
			args.push("--system", config.systemPrompt);
		}

		args.push(options.userPrompt);

		return createCommand(config, "opencode", args);
	},
	parseStdoutLine(line, context) {
		return parseJsonLine("opencode", line, context);
	},
};
