/**
 * Local user helpers tests (updated for per-domain layout).
 *
 * Covers:
 *  - loadHelper / callHelper load-fail → disabled, call-fail → disabled
 *  - Healthy helper transforms params
 *  - Disabled helper stays disabled across calls
 *  - No-op passthrough when no helper file exists
 *  - getAllHelpers / readHelperSource listing
 *  - api-fetch integration: helper transforms params before restGet
 *  - api-fetch integration: disabled helper returns structured error
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

import { startTestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import {
	resetDisabledHelpers,
	callHelper,
	getAllHelpers,
	readHelperSource,
	getDisabledHelperDomains,
} from "../core/local-helpers.js";
import {
	apiFetchTool,
	__test__setBypassUrlSafety,
} from "../tools/api-fetch.js";
import { apiLearnTool } from "../tools/api-learn.js";

// ═══════════════════════════════════════════════════════════════════
// Test server — echoes params so we can verify helper transforms
// ═══════════════════════════════════════════════════════════════════

interface TestCtx {
	serverUrl: string;
	stop: () => Promise<void>;
}

async function createEchoServer(): Promise<TestCtx> {
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");

		// Echo back the query params as JSON
		const params: Record<string, string> = {};
		for (const [k, v] of url.searchParams.entries()) {
			params[k] = v;
		}
		const pathname = url.pathname;

		res.writeHead(200, {
			"Content-Type": "application/json",
			"Cache-Control": "no-cache",
		});
		res.end(
			JSON.stringify({
				data: [{ method: req.method, path: pathname, params }],
			}),
		);
	};

	const { url, stop } = await startTestServer(handler);
	return { serverUrl: url, stop };
}

// ═══════════════════════════════════════════════════════════════════
// Test fixtures — helper .mjs files written to temp guides dir
// ═══════════════════════════════════════════════════════════════════

/** Helper that throws on load (top-level throw). */
const FIXTURE_LOAD_ERROR = `throw new Error("Load failure: missing dep");
`;

/** Helper that throws on invocation. */
const FIXTURE_CALL_ERROR = `export default async function(params, ctx) {
  throw new Error("Execution failure: invalid date format");
};
`;

/** Healthy helper that transforms params. */
const FIXTURE_HEALTHY = `export default function(params, ctx) {
  return { ...params, date: "transformed-" + (params.date ?? "none"), _helper: ctx.operation };
};
`;

/** Helper with no default export (should fail to load). */
const FIXTURE_NO_DEFAULT = `export const foo = 42;
`;

/** Helper that transforms an existing param (date → from-helper-<date>). */
const FIXTURE_TRANSFORM = `export default function(params, ctx) {
  return { ...params, date: "from-helper-" + (params.date ?? "none") };
};
`;

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/** Extract text from a tool result (content[0] may be TextContent | ImageContent). */
import { contentText } from "../tools/utils.js";

let tmpGuidesDir: string;
let ctx: TestCtx;
let echoUrl: string;

/**
 * Write a helper file at <guidesDir>/<domain>/helper.mjs.
 */
function writeFixtureHelper(name: string, content: string): void {
	const domainDir = join(tmpGuidesDir, name);
	mkdirSync(domainDir, { recursive: true });
	writeFileSync(join(domainDir, "helper.mjs"), content, "utf-8");
}

/**
 * Build a recipe that sets helper: true on the 'get' operation.
 * The helper is resolved by the guide's domain name (not a separate helper name).
 */
function recipeWithHelper(
	apiHost: string,
	domain: string = "echo.test",
): string {
	return `---
kind: api
domains: [${domain}]
icon: 📡
shortName: Echo
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: get
    via: restGet
    path: /items/{id}
    accept: json
    helper: true
    params:
      date:
        default: today
      limit:
        default: "10"
---
Echo test guide with helper.
`;
}

function recipeWithoutHelper(
	apiHost: string,
	domain: string = "echo.test",
): string {
	return `---
kind: api
domains: [${domain}]
icon: 📡
shortName: Echo
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: get
    via: restGet
    path: /items/{id}
    accept: json
    params:
      date:
        default: today
      limit:
        default: "10"
---
Echo test guide without helper.
`;
}

// ═══════════════════════════════════════════════════════════════════
// Setup / teardown
// ═══════════════════════════════════════════════════════════════════

beforeAll(async () => {
	ctx = await createEchoServer();
	echoUrl = ctx.serverUrl;

	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-guides-helpers-"));
	setUserGuidesDir(tmpGuidesDir);
	invalidateCache();
	__test__setBypassUrlSafety(true);
});

afterAll(async () => {
	await ctx.stop();
	rmSync(tmpGuidesDir, { recursive: true, force: true });
	resetDisabledHelpers();
	__test__setBypassUrlSafety(false);
});

beforeEach(() => {
	resetDisabledHelpers();
	invalidateCache();
});

// ═══════════════════════════════════════════════════════════════════
// callHelper — load / call guard
// ═══════════════════════════════════════════════════════════════════

describe("callHelper — load / call guard", () => {
	it("returns passthrough when no helper file exists", async () => {
		const result = await callHelper("nonexistent", "op", { foo: "bar" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.params).toEqual({ foo: "bar" });
		}
	});

	it("catches a load error and marks helper disabled", async () => {
		writeFixtureHelper("load-error", FIXTURE_LOAD_ERROR);

		const result = await callHelper("load-error", "op", {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.disabled).toBe(true);
			expect(result.error).toContain("disabled");
		}
		expect(getDisabledHelperDomains()).toContain("load-error");
	});

	it("returns disabled error on subsequent calls to a disabled helper", async () => {
		writeFixtureHelper("double-disabled", FIXTURE_LOAD_ERROR);

		// First call — fails and disables
		const first = await callHelper("double-disabled", "op", {});
		expect(first.ok).toBe(false);

		// Second call — returns disabled immediately (no re-import attempt)
		const second = await callHelper("double-disabled", "op", {});
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.disabled).toBe(true);
			expect(second.error).toContain("disabled");
		}
	});

	it("catches a call error and marks helper disabled", async () => {
		writeFixtureHelper("call-error", FIXTURE_CALL_ERROR);

		const result = await callHelper("call-error", "op", {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.disabled).toBe(true);
			expect(result.error).toContain("disabled");
		}
		expect(getDisabledHelperDomains()).toContain("call-error");
	});

	it("healthy helper transforms params", async () => {
		writeFixtureHelper("healthy", FIXTURE_HEALTHY);

		const result = await callHelper("healthy", "getItems", {
			date: "2026-07-17",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.params).toHaveProperty("date", "transformed-2026-07-17");
			expect(result.params).toHaveProperty("_helper", "getItems");
		}
	});

	it("helper with no default export fails to load", async () => {
		writeFixtureHelper("no-default", FIXTURE_NO_DEFAULT);

		const result = await callHelper("no-default", "op", {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.disabled).toBe(true);
		}
		expect(getDisabledHelperDomains()).toContain("no-default");
	});

	it("resetDisabledHelpers clears the disabled set", async () => {
		writeFixtureHelper("resettable", FIXTURE_LOAD_ERROR);

		await callHelper("resettable", "op", {});
		expect(getDisabledHelperDomains()).toContain("resettable");

		resetDisabledHelpers();
		expect(getDisabledHelperDomains()).not.toContain("resettable");
	});
});

// ═══════════════════════════════════════════════════════════════════
// getAllHelpers / readHelperSource
// ═══════════════════════════════════════════════════════════════════

describe("getAllHelpers / readHelperSource", () => {
	it("lists helpers in the directory", () => {
		writeFixtureHelper("list-test-a", FIXTURE_HEALTHY);
		writeFixtureHelper("list-test-b", FIXTURE_HEALTHY);

		const all = getAllHelpers();
		expect(all).toContain("list-test-a");
		expect(all).toContain("list-test-b");
	});

	it("returns source for an existing helper", () => {
		writeFixtureHelper("source-test", FIXTURE_HEALTHY);

		const source = readHelperSource("source-test");
		expect(source).not.toBeNull();
		expect(source).toContain("params.date");
	});

	it("returns null for a non-existent helper", () => {
		const source = readHelperSource("nope");
		expect(source).toBeNull();
	});

	it("rejects path-traversal domains (../../foo)", () => {
		// Guards assertSafeDomain: a user-typed `/api helpers ../../foo` must
		// not read outside the guides dir.
		expect(() => readHelperSource("../../foo")).toThrow();
		expect(() => readHelperSource("..\\secret")).toThrow();
		expect(() => readHelperSource("..")).toThrow();
		expect(() => readHelperSource("a/b")).toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════
// api-fetch integration — helper transforms params
// ═══════════════════════════════════════════════════════════════════

describe("api-fetch integration with user helpers", () => {
	it("executes a restGet with helper-transformed params", async () => {
		// Write the helper (domain "transform-date" gets helper.mjs)
		writeFixtureHelper("transform-date", FIXTURE_TRANSFORM);
		const recipe = recipeWithHelper(echoUrl, "transform-date");

		// Save via api-learn
		const learnResult = await apiLearnTool.execute(
			"test",
			{ domain: "transform-date", recipe },
			undefined,
			undefined,
			undefined as any,
		);
		expect(contentText(learnResult)).toContain("Guide saved");
		invalidateCache();

		// Execute api-fetch — the helper should transform date param
		const fetchResult = await apiFetchTool.execute(
			"test",
			{
				domain: "transform-date",
				operation: "get",
				params: { id: "42", date: "2026-07-17" },
			},
			undefined,
			undefined,
			undefined as any,
		);
		const text = contentText(fetchResult);
		expect(text).toContain("Echo");
		expect(text).toContain("get");

		// The response body should contain the query params the server received;
		// the helper transformed the date param.
		expect(text).toContain("from-helper-2026-07-17");
	});

	it("returns structured error when helper is disabled", async () => {
		// Write a helper that errors
		writeFixtureHelper("broken", FIXTURE_CALL_ERROR);
		const recipe = recipeWithHelper(echoUrl, "broken");

		const learnResult = await apiLearnTool.execute(
			"test",
			{ domain: "broken", recipe },
			undefined,
			undefined,
			undefined as any,
		);
		expect(contentText(learnResult)).toContain("Guide saved");
		invalidateCache();

		// First api-fetch call — helper fails and is disabled
		const first = await apiFetchTool.execute(
			"test",
			{
				domain: "broken",
				operation: "get",
				params: { id: "1" },
			},
			undefined,
			undefined,
			undefined as any,
		);
		const firstText = contentText(first);
		expect(firstText).toContain("disabled");
		expect(firstText).toContain("broken");
		expect(first!.details).toHaveProperty("error", "helper_disabled");

		// Second call — still disabled, no re-attempt
		const second = await apiFetchTool.execute(
			"test",
			{
				domain: "broken",
				operation: "get",
				params: { id: "2" },
			},
			undefined,
			undefined,
			undefined as any,
		);
		const secondText = contentText(second);
		expect(secondText).toContain("disabled");
	});

	it("without a helper, api-fetch works normally (passthrough)", async () => {
		const recipe = recipeWithoutHelper(echoUrl, "nofetch.test");

		const learnResult = await apiLearnTool.execute(
			"test",
			{ domain: "nofetch.test", recipe },
			undefined,
			undefined,
			undefined as any,
		);
		expect(contentText(learnResult)).toContain("Guide saved");
		invalidateCache();
		resetDisabledHelpers();

		const fetchResult = await apiFetchTool.execute(
			"test",
			{
				domain: "nofetch.test",
				operation: "get",
				params: { id: "7", date: "2026-07-17" },
			},
			undefined,
			undefined,
			undefined as any,
		);
		const text = contentText(fetchResult);
		expect(text).toContain("Echo");
		expect(text).toContain("get");
		// Without helper, the server receives the original params as query string
		expect(text).toContain("2026-07-17");
	});
});

// ═══════════════════════════════════════════════════════════════════
// /api helpers command — visibility
// ═══════════════════════════════════════════════════════════════════

describe("/api helpers command", () => {
	it("lists helpers via handleHelpersSubcommand", async () => {
		writeFixtureHelper("cmd-list-a", FIXTURE_HEALTHY);
		writeFixtureHelper("cmd-list-b", FIXTURE_HEALTHY);

		const notifications: string[] = [];
		const mockCtx = {
			ui: {
				notify: (text: string, _level: string) => {
					notifications.push(text);
				},
			},
		} as any;

		const { handleHelpersSubcommand } = await import(
			"../core/helpers-command.js"
		);
		await handleHelpersSubcommand("", mockCtx);

		const joined = notifications.join("\n");
		expect(joined).toContain("cmd-list-a");
		expect(joined).toContain("cmd-list-b");
	});

	it("shows a single helper source via handleHelpersSubcommand", async () => {
		writeFixtureHelper(
			"show-source",
			`export default function(p, c) { return p; }\n`,
		);

		const notifications: string[] = [];
		const mockCtx = {
			ui: {
				notify: (text: string, _level: string) => {
					notifications.push(text);
				},
			},
		} as any;

		const { handleHelpersSubcommand } = await import(
			"../core/helpers-command.js"
		);
		await handleHelpersSubcommand("show-source", mockCtx);

		const joined = notifications.join("\n");
		expect(joined).toContain("show-source");
		expect(joined).toContain("Helper contract");
	});

	it("shows warning for unknown domain", async () => {
		const notifications: string[] = [];
		const mockCtx = {
			ui: {
				notify: (text: string, level: string) => {
					notifications.push(`${level}: ${text}`);
				},
			},
		} as any;

		const { handleHelpersSubcommand } = await import(
			"../core/helpers-command.js"
		);
		await handleHelpersSubcommand("does-not-exist", mockCtx);

		const joined = notifications.join("\n");
		expect(joined).toContain("warning:");
		expect(joined).toContain("does-not-exist");
	});

	it("shows empty notice when no helpers exist", async () => {
		// Ensure a clean, empty temp dir
		const emptyDir = mkdtempSync(join(tmpdir(), "empty-helpers-"));
		setUserGuidesDir(emptyDir);
		resetDisabledHelpers();

		const notifications: string[] = [];
		const mockCtx = {
			ui: {
				notify: (text: string, _level: string) => {
					notifications.push(text);
				},
			},
		} as any;

		const { handleHelpersSubcommand } = await import(
			"../core/helpers-command.js"
		);
		await handleHelpersSubcommand("", mockCtx);

		const joined = notifications.join("\n");
		expect(joined).toContain("No local helpers found");

		// Restore
		setUserGuidesDir(tmpGuidesDir);
	});
});
