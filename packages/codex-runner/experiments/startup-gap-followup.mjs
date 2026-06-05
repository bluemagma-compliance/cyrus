// Reproduce the Slack symptom: a follow-up that arrives during the startup gap
// (config build / process spawn / thread start, before the turn is active).
// With the fix it must be buffered and incorporated, not dropped.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexRunner } from "../dist/index.js";

const wd = mkdtempSync(join(tmpdir(), "codex-gap-"));
execFileSync("git", ["init", "-q"], { cwd: wd });
writeFileSync(join(wd, "README.md"), "# x\n");

const runner = new CodexRunner({
  workingDirectory: wd, cyrusHome: join(process.env.HOME, ".cyrus"),
  sandbox: "read-only", useAppServer: true,
});
const texts = [];
runner.on("message", (m) => {
  if (m.type === "assistant")
    for (const b of m.message.content ?? []) if (b?.type === "text") texts.push(b.text);
});
runner.on("error", (e) => console.log("[gap] runner error:", e.message));

// Start the turn but DON'T await — then immediately fire a follow-up. At this
// point the runner is mid-startup (build/login-status/spawn), turn not active.
const p = runner.startStreaming("Reply with exactly the word PEAR. One word only. Do not use tools.");
console.log("[gap] isStreaming right after start (should be true):", runner.isStreaming());
console.log("[gap] isTurnActive right after start (should be false):", runner.backend?.isTurnActive?.() ?? "n/a");
let threw = false;
try {
  runner.addStreamMessage("ALSO: append the word KIWI to your reply.");
} catch (e) { threw = true; console.log("[gap] addStreamMessage threw:", e.message); }
console.log("[gap] addStreamMessage threw during gap?", threw, "(should be false)");

await p;

const all = texts.join(" ");
const kiwi = /KIWI/.test(all);
console.log("\n===== STARTUP-GAP FOLLOWUP SUMMARY =====");
console.log("follow-up buffered (not thrown):", !threw);
console.log("follow-up incorporated (KIWI present):", kiwi);
console.log("final text sample:", JSON.stringify(all.slice(-120)));
console.log("========================================");
process.exit(!threw && kiwi ? 0 : 1);
