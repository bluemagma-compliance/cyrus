import type {
	HookCallbackMatcher,
	PostToolUseFailureHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { OOM_MARKER, wrapCommand } from "../src/hooks/cyrus-tool-exec.js";
import {
	buildMemoryLimitNotice,
	buildOomReportHook,
	extractResultText,
	HttpOomEventReporter,
	type OomEvent,
	type OomEventReporter,
} from "../src/hooks/OomReportHook.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

const MARKER_TEXT = `${OOM_MARKER} exceeded 1300M memory budget (peak 1500000000 bytes).`;

/**
 * A `PostToolUseFailure` input — the event an OOM-killed (non-zero-exit) Bash
 * command is routed to. The failure detail (and thus the OOM marker) lives in
 * the `error` string.
 */
function makeFailureInput(
	errorText: string,
	command = "pnpm test",
): PostToolUseFailureHookInput {
	return {
		hook_event_name: "PostToolUseFailure",
		session_id: "s",
		transcript_path: "t",
		cwd: "/work",
		tool_name: "Bash",
		tool_input: { command },
		tool_use_id: "u",
		error: errorText,
	} as PostToolUseFailureHookInput;
}

async function runPost(
	matcher: HookCallbackMatcher,
	input: PostToolUseFailureHookInput,
): Promise<any> {
	const fn = matcher.hooks[0];
	return fn(input as any, "u", { signal: new AbortController().signal });
}

function postMatcher(reporter: OomEventReporter): HookCallbackMatcher {
	const hook = buildOomReportHook(silentLogger, reporter);
	const matcher = hook.PostToolUseFailure?.[0];
	if (!matcher) {
		throw new Error("expected a PostToolUseFailure matcher");
	}
	return matcher;
}

/** A reporter that records the events it was asked to deliver. */
function recordingReporter(): OomEventReporter & { events: OomEvent[] } {
	const events: OomEvent[] = [];
	return {
		events,
		async report(event) {
			events.push(event);
		},
	};
}

describe("extractResultText", () => {
	it("returns strings unchanged", () => {
		expect(extractResultText("hello")).toBe("hello");
	});

	it("joins string fields of an object (e.g. stdout/stderr)", () => {
		const text = extractResultText({ stdout: "out", stderr: "err" });
		expect(text).toContain("out");
		expect(text).toContain("err");
	});

	it("returns empty string for null", () => {
		expect(extractResultText(null)).toBe("");
	});
});

describe("buildOomReportHook", () => {
	it("registers a Bash matcher under PostToolUseFailure (not PostToolUse)", () => {
		const hook = buildOomReportHook(silentLogger, recordingReporter());
		expect(hook.PostToolUse).toBeUndefined();
		expect(hook.PostToolUseFailure?.[0]?.matcher).toBe("Bash");
	});

	it("does not report when the marker is absent", async () => {
		const reporter = recordingReporter();
		await runPost(
			postMatcher(reporter),
			makeFailureInput("command failed: exit 1"),
		);
		expect(reporter.events).toHaveLength(0);
	});

	it("reports the full command, a program label, and exit code from `error`", async () => {
		const reporter = recordingReporter();
		await runPost(
			postMatcher(reporter),
			makeFailureInput(MARKER_TEXT, "pnpm run heavy"),
		);
		expect(reporter.events).toEqual([
			{
				command: "pnpm run heavy",
				program: "pnpm",
				budgetMb: 1300,
				peakBytes: 1500000000,
				exitCode: 137,
			},
		]);
	});

	it("also finds the marker if a future SDK carries it in tool_response", async () => {
		const reporter = recordingReporter();
		const input = {
			...makeFailureInput("", "node server.js"),
			error: "",
			tool_response: { stderr: MARKER_TEXT },
		} as unknown as PostToolUseFailureHookInput;
		await runPost(postMatcher(reporter), input);
		expect(reporter.events[0]).toMatchObject({
			command: "node server.js",
			program: "node",
			budgetMb: 1300,
			peakBytes: 1500000000,
			exitCode: 137,
		});
	});

	it("sends the ENTIRE unwrapped command untruncated, plus a safe program label", async () => {
		const reporter = recordingReporter();
		// The full command — including args — is reported so OOMs are debuggable;
		// the program label stays argument-free for aggregation.
		const inner = "TOKEN=shh ./deploy.sh --key abc";
		const wrapped = wrapCommand(inner, "1300");
		await runPost(
			postMatcher(reporter),
			makeFailureInput(MARKER_TEXT, wrapped),
		);
		expect(reporter.events[0].command).toBe(inner);
		expect(reporter.events[0].program).toBe("deploy.sh");
	});

	it("reports oomKillCount when the marker carries it", async () => {
		const reporter = recordingReporter();
		const marker = `${OOM_MARKER} exceeded 1300M memory budget (peak 1500000000 bytes, oom_kill 3).`;
		await runPost(
			postMatcher(reporter),
			makeFailureInput(marker, "cargo build"),
		);
		expect(reporter.events[0].oomKillCount).toBe(3);
	});

	it("enriches the report with session/issue/runner context", async () => {
		const reporter = recordingReporter();
		const hook = buildOomReportHook(silentLogger, reporter, {
			sessionId: "sess-1",
			sessionSource: "linear",
			runnerType: "claude",
			model: "claude-opus-4-8",
			workspacePath: "/work/tree",
			linearIssueId: "issue-uuid",
			linearIssueIdentifier: "CYPACK-1274",
			linearIssueUrl: "https://linear.app/ceedar/issue/CYPACK-1274",
			getRunnerSessionId: () => "claude-sess-9",
		});
		const matcher = hook.PostToolUseFailure?.[0];
		if (!matcher) throw new Error("expected a PostToolUseFailure matcher");
		await runPost(matcher, makeFailureInput(MARKER_TEXT, "cargo build"));
		expect(reporter.events[0]).toEqual({
			command: "cargo build",
			program: "cargo",
			budgetMb: 1300,
			peakBytes: 1500000000,
			exitCode: 137,
			sessionId: "sess-1",
			sessionSource: "linear",
			runnerSessionId: "claude-sess-9",
			runnerType: "claude",
			model: "claude-opus-4-8",
			linearIssueId: "issue-uuid",
			linearIssueIdentifier: "CYPACK-1274",
			linearIssueUrl: "https://linear.app/ceedar/issue/CYPACK-1274",
			workspacePath: "/work/tree",
		});
	});

	it("reads runnerSessionId lazily, at report time (not build time)", async () => {
		const reporter = recordingReporter();
		let runnerSessionId: string | undefined;
		const hook = buildOomReportHook(silentLogger, reporter, {
			getRunnerSessionId: () => runnerSessionId,
		});
		const matcher = hook.PostToolUseFailure?.[0];
		if (!matcher) throw new Error("expected a PostToolUseFailure matcher");
		// Assigned only after the hook is built — mirrors claude_session_id_assigned.
		runnerSessionId = "assigned-late";
		await runPost(matcher, makeFailureInput(MARKER_TEXT, "cargo build"));
		expect(reporter.events[0].runnerSessionId).toBe("assigned-late");
	});

	it("invokes onOom once when the marker is present", async () => {
		const reporter = recordingReporter();
		const onOom = vi.fn();
		const hook = buildOomReportHook(silentLogger, reporter, { onOom });
		const matcher = hook.PostToolUseFailure?.[0];
		if (!matcher) throw new Error("expected a PostToolUseFailure matcher");
		await runPost(matcher, makeFailureInput(MARKER_TEXT, "cargo build"));
		expect(onOom).toHaveBeenCalledTimes(1);
	});

	it("does not invoke onOom when the marker is absent", async () => {
		const onOom = vi.fn();
		const hook = buildOomReportHook(silentLogger, recordingReporter(), {
			onOom,
		});
		const matcher = hook.PostToolUseFailure?.[0];
		if (!matcher) throw new Error("expected a PostToolUseFailure matcher");
		await runPost(matcher, makeFailureInput("exit 1"));
		expect(onOom).not.toHaveBeenCalled();
	});

	it("invokes onOom even when the telemetry reporter throws", async () => {
		const onOom = vi.fn();
		const throwingReporter: OomEventReporter = {
			async report() {
				throw new Error("boom");
			},
		};
		const hook = buildOomReportHook(silentLogger, throwingReporter, { onOom });
		const matcher = hook.PostToolUseFailure?.[0];
		if (!matcher) throw new Error("expected a PostToolUseFailure matcher");
		await runPost(matcher, makeFailureInput(MARKER_TEXT));
		expect(onOom).toHaveBeenCalledTimes(1);
	});

	it("fails open (returns {}) when the reporter throws", async () => {
		const reporter: OomEventReporter = {
			async report() {
				throw new Error("boom");
			},
		};
		const result = await runPost(
			postMatcher(reporter),
			makeFailureInput(MARKER_TEXT),
		);
		expect(result).toEqual({});
	});
});

describe("buildMemoryLimitNotice", () => {
	const billingUrl = "https://app.atcyrus.com/settings/billing";

	it("links the billing page and states the upgrade rationale, concisely", () => {
		const notice = buildMemoryLimitNotice(billingUrl);
		expect(notice).toContain(`(${billingUrl})`);
		expect(notice).toContain("memory budget");
		// The "why": more compute lets heavy work finish in one pass.
		expect(notice).toContain("More compute");
		expect(notice).toContain("finish in one pass");
		// Renders as a distinct blockquote footer.
		expect(notice.startsWith("> ")).toBe(true);
	});
});

describe("HttpOomEventReporter", () => {
	const event: OomEvent = {
		command: "pnpm run heavy --filter x",
		program: "pnpm",
		budgetMb: 1300,
		peakBytes: 1500000000,
		exitCode: 137,
	};

	it("does not POST when CYRUS_API_KEY is missing", async () => {
		const fetchImpl = vi.fn();
		const reporter = new HttpOomEventReporter(silentLogger, {
			getEnv: () => undefined,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await reporter.report(event);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("POSTs to /api/oom-event with the bearer key and JSON body", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const reporter = new HttpOomEventReporter(silentLogger, {
			getEnv: (n) => (n === "CYRUS_API_KEY" ? "secret-key" : undefined),
			getBaseUrl: () => "https://app.atcyrus.com",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await reporter.report(event);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, options] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://app.atcyrus.com/api/oom-event");
		expect(options.method).toBe("POST");
		expect(options.headers.Authorization).toBe("Bearer secret-key");
		expect(JSON.parse(options.body)).toEqual({
			command: "pnpm run heavy --filter x",
			program: "pnpm",
			budgetMb: 1300,
			peakBytes: 1500000000,
			exitCode: 137,
		});
	});

	it("strips trailing slashes from the base URL", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const reporter = new HttpOomEventReporter(silentLogger, {
			getEnv: (n) => (n === "CYRUS_API_KEY" ? "k" : undefined),
			getBaseUrl: () => "https://app.atcyrus.com/",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await reporter.report(event);
		expect(fetchImpl.mock.calls[0][0]).toBe(
			"https://app.atcyrus.com/api/oom-event",
		);
	});

	it("fails open (does not throw) when fetch rejects", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
		const reporter = new HttpOomEventReporter(silentLogger, {
			getEnv: (n) => (n === "CYRUS_API_KEY" ? "secret-key" : undefined),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await expect(reporter.report(event)).resolves.toBeUndefined();
	});
});
