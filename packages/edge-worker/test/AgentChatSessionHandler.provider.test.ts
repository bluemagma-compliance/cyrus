import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentChatSessionHandler,
	type ChatPlatformAdapter,
} from "../src/AgentChatSessionHandler.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

// Minimal stand-in for ChatPlatformAdapter. None of these methods are
// invoked by the constructor — they only matter once handleEvent runs —
// so we throw to make accidental invocations loud in test output.
function makeAdapter(): ChatPlatformAdapter<unknown> {
	const fail = (name: string) => () => {
		throw new Error(`unexpected call to ${name} in constructor test`);
	};
	return {
		platformName: "slack",
		extractTaskInstructions: fail("extractTaskInstructions") as never,
		getThreadKey: fail("getThreadKey") as never,
		getEventId: fail("getEventId") as never,
		buildSystemPrompt: fail("buildSystemPrompt") as never,
		fetchThreadContext: fail("fetchThreadContext") as never,
		postReply: fail("postReply") as never,
		acknowledgeReceipt: fail("acknowledgeReceipt") as never,
		notifyBusy: fail("notifyBusy") as never,
	};
}

function makeDeps(
	overrides: Partial<
		Parameters<(typeof AgentChatSessionHandler.prototype)["constructor"]>[1]
	> = {},
) {
	return {
		onWebhookStart: () => {},
		onWebhookEnd: () => {},
		onError: () => {},
		...overrides,
	};
}

describe("AgentChatSessionHandler provider selection", () => {
	let originalDaytonaKey: string | undefined;

	beforeEach(() => {
		originalDaytonaKey = process.env.DAYTONA_API_KEY;
		delete process.env.DAYTONA_API_KEY;
	});

	afterEach(async () => {
		if (originalDaytonaKey === undefined) {
			delete process.env.DAYTONA_API_KEY;
		} else {
			process.env.DAYTONA_API_KEY = originalDaytonaKey;
		}
	});

	it("defaults to local provider when none specified and does not require DAYTONA_API_KEY", () => {
		expect(
			() =>
				new AgentChatSessionHandler(makeAdapter(), makeDeps(), silentLogger),
		).not.toThrow();
	});

	it("accepts provider='local' without DAYTONA_API_KEY", () => {
		expect(
			() =>
				new AgentChatSessionHandler(
					makeAdapter(),
					makeDeps({ provider: "local" }),
					silentLogger,
				),
		).not.toThrow();
	});

	it("throws when provider='daytona' is requested without DAYTONA_API_KEY", () => {
		expect(
			() =>
				new AgentChatSessionHandler(
					makeAdapter(),
					makeDeps({ provider: "daytona" }),
					silentLogger,
				),
		).toThrow(/DAYTONA_API_KEY/);
	});

	it("accepts provider='daytona' when DAYTONA_API_KEY is set", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		expect(
			() =>
				new AgentChatSessionHandler(
					makeAdapter(),
					makeDeps({ provider: "daytona" }),
					silentLogger,
				),
		).not.toThrow();
	});
});
