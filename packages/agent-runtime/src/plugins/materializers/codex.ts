import type { RunnerSandbox, RuntimePlugin } from "../../types.js";
import { renderSkillMd } from "../skill-md.js";

export interface CodexMaterializeResult {
	/**
	 * Inline `-c` CLI overrides the caller should append to the codex
	 * invocation, e.g. `-c 'mcp_servers.<name>={command="...",args=[...]}'`.
	 * Each entry is a complete `key=value` string ready for `-c`.
	 */
	cliConfigOverrides: string[];
	/**
	 * The `HOME` value the caller should set in the harness invocation
	 * env. Codex discovers skills at `$HOME/.agents/skills/<name>/`
	 * (NOT `$CODEX_HOME/skills/` — verified empirically), so we pin
	 * HOME to a per-session directory.
	 */
	homeOverride: string;
	filesWritten: string[];
}

/**
 * Materialize a RuntimePlugin for Codex.
 *
 * Skills → files at `<homeOverride>/.agents/skills/<name>/SKILL.md` +
 *          optional `agents/openai.yaml` for the OpenAI runtime.
 * MCP servers → returned as inline `-c mcp_servers.<name>={...}` CLI
 *               overrides (no file written). Caller appends them to
 *               the codex invocation.
 * Hooks → deferred for v1 (Codex hooks schema is version-pinned and
 *         unstable; the materializer silently drops them).
 *
 * `homeOverride` is the value the caller must set as the harness's
 * HOME env var. Override HOME (not CODEX_HOME) for skill isolation.
 */
export async function materializePluginForCodex(
	plugin: RuntimePlugin,
	sandbox: RunnerSandbox,
	homeOverride: string,
): Promise<CodexMaterializeResult> {
	const filesWritten: string[] = [];

	if (plugin.skills && plugin.skills.length > 0) {
		const skillsRoot = joinPath(homeOverride, ".agents", "skills");
		await sandbox.filesystem.mkdir(skillsRoot);
		for (const skill of plugin.skills) {
			const skillDir = joinPath(skillsRoot, skill.name);
			await sandbox.filesystem.mkdir(skillDir);
			const skillPath = joinPath(skillDir, "SKILL.md");
			await sandbox.filesystem.writeFile(skillPath, renderSkillMd(skill));
			filesWritten.push(skillPath);

			// Codex's OpenAI runtime expects an `agents/openai.yaml` sibling
			// describing the skill at the protocol level. Without this, codex
			// will still load the SKILL.md but the surface area in the agent
			// directory is incomplete. Emit a minimal one.
			const agentsDir = joinPath(skillDir, "agents");
			await sandbox.filesystem.mkdir(agentsDir);
			const openaiYamlPath = joinPath(agentsDir, "openai.yaml");
			const yaml = [
				"interface:",
				`  display_name: ${skill.name}`,
				`  short_description: ${yamlString(skill.description)}`,
				`  default_prompt: ${yamlString(skill.description)}`,
			].join("\n");
			await sandbox.filesystem.writeFile(openaiYamlPath, `${yaml}\n`);
			filesWritten.push(openaiYamlPath);

			for (const asset of skill.assets ?? []) {
				const assetPath = joinPath(skillDir, asset.path);
				const assetDir = dirnameOf(assetPath);
				if (assetDir) await sandbox.filesystem.mkdir(assetDir);
				await sandbox.filesystem.writeFile(assetPath, asset.content);
				filesWritten.push(assetPath);
			}
		}
	}

	const cliConfigOverrides: string[] = [];
	if (plugin.mcpServers) {
		for (const [serverName, cfg] of Object.entries(plugin.mcpServers)) {
			// Build inline TOML for codex's `-c key=value` flag.
			// Codex parses the value as TOML, so command/args/env become a
			// TOML table literal.
			const parts: string[] = [];
			if (cfg.command) parts.push(`command=${tomlString(cfg.command)}`);
			if (cfg.args && cfg.args.length > 0) {
				const argsLit = cfg.args.map(tomlString).join(",");
				parts.push(`args=[${argsLit}]`);
			}
			if (cfg.env && Object.keys(cfg.env).length > 0) {
				const envEntries = Object.entries(cfg.env)
					.map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`)
					.join(",");
				parts.push(`env={${envEntries}}`);
			}
			if (cfg.url) parts.push(`url=${tomlString(cfg.url)}`);
			cliConfigOverrides.push(
				`mcp_servers.${tomlKey(serverName)}={${parts.join(",")}}`,
			);
		}
	}

	// Hooks deliberately not materialized for codex in v1.

	return { cliConfigOverrides, homeOverride, filesWritten };
}

function joinPath(...parts: string[]): string {
	return parts
		.filter((p) => p !== "")
		.map((p) => p.replace(/\/+$/, ""))
		.join("/")
		.replace(/\/{2,}/g, "/");
}

function dirnameOf(path: string): string | undefined {
	const idx = path.lastIndexOf("/");
	return idx > 0 ? path.slice(0, idx) : undefined;
}

/** Wrap a TOML string scalar. */
function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Quote a TOML bare key when it contains non-bare characters. */
function tomlKey(value: string): string {
	if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
	return tomlString(value);
}

function yamlString(value: string): string {
	if (/[:#\n\\"]/.test(value)) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}
