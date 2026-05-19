/**
 * Cursor SDK driver — spawned by the cursor harness adapter in place of
 * the `cursor-agent` CLI.
 *
 * Why this exists: `cursor-agent --output-format stream-json` emits a
 * schema that does NOT match `@cursor/sdk`'s `SDKMessage` union (verified
 * empirically — fields like `agent_id` vs `session_id`, `status` vs
 * `subtype`, missing `result` variant). Wrapping `@cursor/sdk` directly
 * means the bytes on the wire ARE `SDKMessage` by construction —
 * `HarnessRawByKind["cursor"]` can be the SDK union with no drift.
 *
 * Wire format: one JSON `SDKMessage` per line on stdout, the same shape
 * `parseJsonLine` already parses for the other harnesses.
 *
 * Invocation (set up by `cursor.ts`):
 *   node <path-to-this-file> \
 *       --prompt <text>          # required
 *       [--model <id>]
 *       [--cwd <dir>]
 *       [--system-prompt <text>]
 *       [--agent-id <id>]        # resume an existing agent (cross-turn)
 *       [--agent-id-file <path>] # writes agentId here after Agent.create()
 *
 * Auth: reads `CURSOR_API_KEY` from the environment. Exits 2 if missing.
 *
 * Stdout: one JSON line per `SDKMessage`, no trailing summary.
 * Stderr: human-readable error text only when something goes wrong.
 * Exit:   0 on completion, 1 on runtime error, 2 on misuse.
 */

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Agent } from "@cursor/sdk";

interface Argv {
	prompt: string;
	model?: string;
	cwd?: string;
	systemPrompt?: string;
	agentId?: string;
	agentIdFile?: string;
}

function parseArgv(): Argv {
	const { values } = parseArgs({
		options: {
			prompt: { type: "string" },
			model: { type: "string" },
			cwd: { type: "string" },
			"system-prompt": { type: "string" },
			"agent-id": { type: "string" },
			"agent-id-file": { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});

	if (!values.prompt) {
		process.stderr.write("cursor-driver: --prompt is required\n");
		process.exit(2);
	}

	return {
		prompt: values.prompt,
		model: values.model,
		cwd: values.cwd,
		systemPrompt: values["system-prompt"],
		agentId: values["agent-id"],
		agentIdFile: values["agent-id-file"],
	};
}

async function main(): Promise<void> {
	const argv = parseArgv();

	const apiKey = process.env.CURSOR_API_KEY?.trim();
	if (!apiKey) {
		process.stderr.write(
			"cursor-driver: CURSOR_API_KEY is not set in the environment\n",
		);
		process.exit(2);
	}

	const agent = argv.agentId
		? await Agent.resume(argv.agentId, { apiKey })
		: await Agent.create({
				apiKey,
				model: argv.model ? { id: argv.model } : undefined,
				local: { cwd: argv.cwd ?? process.cwd() },
			});

	// Persist the agentId so the cursor adapter can pass it back as
	// --agent-id on the next turn (mirrors Claude's --continue / Codex's
	// thread-id resume). Best-effort: a write failure logs to stderr but
	// doesn't kill the run.
	if (argv.agentIdFile) {
		await writeFile(argv.agentIdFile, agent.agentId, "utf8").catch(
			(err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(
					`cursor-driver: failed to persist agent-id-file: ${msg}\n`,
				);
			},
		);
	}

	const promptText = argv.systemPrompt
		? `${argv.systemPrompt}\n\n${argv.prompt}`
		: argv.prompt;

	try {
		const run = await agent.send(promptText);
		try {
			for await (const message of run.stream()) {
				// One SDKMessage per line. JSON.stringify is safe here —
				// the SDK union is plain serializable data (no live
				// references).
				process.stdout.write(`${JSON.stringify(message)}\n`);
			}
			await run.wait();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`cursor-driver: stream error: ${msg}\n`);
			process.exitCode = 1;
		}
	} finally {
		agent.close();
	}
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`cursor-driver: fatal: ${msg}\n`);
	process.exit(1);
});
