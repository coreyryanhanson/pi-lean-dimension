/**
 * /api verify command tests — mocked transport (no network).
 *
 * Covers:
 *  - strict threshold: all-pass → stamp + cache invalidation; partial-fail /
 *    all-fail → no stamp; all-skipped → no stamp + warning.
 *  - auth precheck fail-fast (no HTTP when a requires secret is missing).
 *  - param precheck: unsatisfiable params skip (not fail); verify.json makes
 *    them run; verify.json value wins over the op default; malformed
 *    verify.json is a load error, not a crash; passthrough ops verifiable via
 *    the sidecar.
 *  - helper-disabled op → skip (not fail), named in report.
 *  - transform failure → non-blocking (op counts as pass).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../core/transport.js")>(
		"../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { fetchUrl } from "../core/transport.js";
import {
	setUserGuidesDir,
	invalidateCache,
	findGuidesByDomain,
} from "../core/guide-store.js";
import { setSecretsDir } from "../core/secrets-store.js";
import { handleVerifySubcommand } from "../core/verify-command.js";
import { TODAY } from "../core/parse-api-guide.js";
import { resetDisabledHelpers } from "../core/local-helpers.js";

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

interface OpDef {
	name: string;
	via?: string;
	path: string;
	/** Extra op-level YAML lines (params / pagination / helper / transform / passthrough). */
	extra?: string;
}

function opBlock(d: OpDef): string {
	const lines = [
		`  - name: ${d.name}`,
		`    via: ${d.via ?? "restGet"}`,
		`    path: ${d.path}`,
		`    accept: json`,
	];
	if (d.extra) lines.push(d.extra);
	return lines.join("\n");
}

const OP_HEALTH: OpDef = { name: "health", path: "/health" };
const OP_BROKEN: OpDef = { name: "broken", path: "/broken" };
const OP_LIST: OpDef = {
	name: "list",
	via: "paginate",
	path: "/items",
	extra:
		"    pagination:\n" +
		"      style: offset-limit\n" +
		"      pageParam: page\n" +
		"      pageSizeParam: limit\n" +
		"      pageSize: 2\n" +
		"      itemsPath: items",
};
const OP_GET: OpDef = { name: "get", path: "/thing/{id}" };
const OP_SEARCH_REQUIRED: OpDef = {
	name: "search",
	path: "/search",
	extra: "    params:\n      q:\n        required: true",
};
const OP_SEARCH_DEFAULT: OpDef = {
	name: "search",
	path: "/search",
	extra: "    params:\n      q:\n        default: all",
};
const OP_QUERY: OpDef = {
	name: "query",
	path: "/query",
	extra: "    passthrough: true",
};
const OP_HELPER: OpDef = {
	name: "helperOp",
	path: "/helper",
	extra: "    helper: true",
};
const OP_TRANSFORM: OpDef = {
	name: "transformOp",
	path: "/transform",
	extra: "    transform: true",
};
const OP_GROUP: OpDef = {
	name: "group",
	path: "/group",
	extra:
		"    requiresAnyOf: [id, slug, code]\n" +
		"    params:\n" +
		"      id:\n" +
		"        description: Resource id.\n" +
		"      slug:\n" +
		"        description: Resource slug.\n" +
		"      code:\n" +
		"        description: Resource code.",
};

/** A valid recipe for the verify.test domain. */
function recipe(
	opBlocks: string,
	authBlock?: string,
	shortName = "Verify",
): string {
	const auth = authBlock ?? "auth:\n  kind: none";
	return `---
kind: api
domains: [verify.test]
icon: ✅
shortName: ${shortName}
updated: 2026-07-17
apiHost: https://verify.test
verified: 2026-07-17
${auth}
responseShape:
  format: json
  charset: utf-8
operations:
${opBlocks}
---
`;
}

/** Helper that throws on invocation (session-disabled after first call). */
const FIXTURE_CALL_ERROR = `export default async function(params, ctx) {
  throw new Error("Execution failure");
};
`;

/** Helper whose post-response transform throws. */
const FIXTURE_TRANSFORM_THROWS = `export function transform() {
  throw new Error("boom");
};
`;

// ═══════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════

let tmpGuidesDir: string;
let tmpSecretsDir: string;

beforeEach(() => {
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-verify-"));
	tmpSecretsDir = mkdtempSync(join(tmpdir(), "host-verify-secrets-"));
	setUserGuidesDir(tmpGuidesDir);
	setSecretsDir(tmpSecretsDir);
	invalidateCache();
	resetDisabledHelpers();
	vi.mocked(fetchUrl).mockReset();
	vi.mocked(fetchUrl).mockImplementation(async (url: string) => {
		if (url.includes("/broken")) {
			return {
				status: 500,
				headers: {},
				body: JSON.stringify({ error: "boom" }),
				cached: false,
			};
		}
		return {
			status: 200,
			headers: {},
			body: JSON.stringify({ ok: true }),
			cached: false,
		};
	});
});

afterEach(() => {
	rmSync(tmpGuidesDir, { recursive: true, force: true });
	rmSync(tmpSecretsDir, { recursive: true, force: true });
});

function setupGuide(
	recipeText: string,
	opts?: { verifyJson?: string; helper?: { content: string } },
): void {
	setupGuideIn("verify", recipeText, opts);
}

/** Setup a guide in an explicit directory (multi-guide domains). */
function setupGuideIn(
	dirName: string,
	recipeText: string,
	opts?: { verifyJson?: string; helper?: { content: string } },
): void {
	const dir = join(tmpGuidesDir, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), recipeText, "utf-8");
	if (opts?.verifyJson !== undefined) {
		writeFileSync(join(dir, "verify.json"), opts.verifyJson, "utf-8");
	}
	if (opts?.helper) {
		writeFileSync(join(dir, "helper.mjs"), opts.helper.content, "utf-8");
	}
	invalidateCache();
}

function readGuide(): string {
	return readGuideIn("verify");
}

function readGuideIn(dirName: string): string {
	return readFileSync(join(tmpGuidesDir, dirName, "guide.md"), "utf-8");
}

function mockCtx(overrides: Record<string, unknown> = {}): any {
	return { ui: { notify: vi.fn() }, hasUI: true, ...overrides };
}

function notifyText(ctx: any): string {
	return ctx.ui.notify.mock.calls.map((c: unknown[]) => c[0]).join("\n");
}

function requestedUrls(): string[] {
	return vi.mocked(fetchUrl).mock.calls.map((c) => String(c[0]));
}

// ═══════════════════════════════════════════════════════════════════
// Threshold + stamp
// ═══════════════════════════════════════════════════════════════════

describe("/api verify — threshold + stamp", () => {
	it("stamps verified: today on all-pass and invalidates the cache", async () => {
		setupGuide(recipe([opBlock(OP_HEALTH), opBlock(OP_LIST)].join("\n")));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain(
			`✅ All runnable ops passed — stamped verified: ${TODAY()}`,
		);
		expect(text).toContain("✓ health — /health (restGet)");
		expect(text).toContain("✓ list — 0 item(s) (paginate)");
		expect(readGuide()).toContain(`verified: ${TODAY()}`);
		// Cache invalidated — a fresh lookup sees the new date without a reload.
		expect(findGuidesByDomain("verify.test")[0]!.guide.verified).toBe(TODAY());
	});

	it("picks a guide interactively (TUI) and verifies only that guide", async () => {
		// Two guides claim verify.test; the picker resolves to the second.
		setupGuideIn("verify-a", recipe(opBlock(OP_HEALTH), undefined, "Verify A"));
		setupGuideIn("verify-b", recipe(opBlock(OP_LIST), undefined, "Verify B"));
		const ctx = mockCtx({
			mode: "tui",
			ui: {
				notify: vi.fn(),
				custom: vi.fn(async () => "verify-b"),
			},
		});
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain(
			`✅ All runnable ops passed — stamped verified: ${TODAY()}`,
		);
		expect(text).toContain("✓ list — 0 item(s) (paginate)");
		// Only the picked guide's file is stamped; the sibling is untouched.
		expect(readGuideIn("verify-b")).toContain(`verified: ${TODAY()}`);
		expect(readGuideIn("verify-a")).toContain("verified: 2026-07-17");
	});

	it("does not stamp on partial failure and names the failing op", async () => {
		setupGuide(recipe([opBlock(OP_HEALTH), opBlock(OP_BROKEN)].join("\n")));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("❌ NOT stamped");
		expect(text).toContain("✗ broken — Unexpected HTTP 500");
		expect(text).toContain("✓ health");
		expect(readGuide()).toContain("verified: 2026-07-17"); // unchanged
	});

	it("does not stamp on all-fail", async () => {
		const brokenA = { ...OP_BROKEN, name: "brokenA" };
		const brokenB = { ...OP_BROKEN, name: "brokenB" };
		setupGuide(recipe([opBlock(brokenA), opBlock(brokenB)].join("\n")));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("❌ NOT stamped — 2 op(s) failed");
		expect(readGuide()).toContain("verified: 2026-07-17");
	});

	it("does not stamp when all ops are skipped and warns with the fix", async () => {
		setupGuide(recipe([opBlock(OP_GET), opBlock(OP_SEARCH_REQUIRED)].join("\n")));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("⚠ NOT stamped — all ops skipped");
		expect(text).toContain(
			"⏭ get — skipped: requires agent-supplied params (id)",
		);
		expect(text).toContain(
			"⏭ search — skipped: requires agent-supplied params (q)",
		);
		expect(text).toContain("verify.json");
		expect(readGuide()).toContain("verified: 2026-07-17");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Auth precheck
// ═══════════════════════════════════════════════════════════════════

describe("/api verify — auth precheck", () => {
	it("short-circuits on an unprovisioned requires secret without any HTTP", async () => {
		const authBlock =
			"auth:\n" +
			"  kind: static-key\n" +
			"  requires: [apiKey]\n" +
			"  secretRefs:\n" +
			"    Authorization: apiKey\n" +
			"  headerPrefixes:\n" +
			'    Authorization: "Bearer "';
		setupGuide(recipe(opBlock(OP_HEALTH), authBlock));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("requires a secret not yet provisioned: apiKey");
		expect(text).toContain("Run /api secrets verify.test");
		expect(vi.mocked(fetchUrl)).not.toHaveBeenCalled();
		expect(readGuide()).toContain("verified: 2026-07-17");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Param precheck + verify.json sidecar
// ═══════════════════════════════════════════════════════════════════

describe("/api verify — param precheck + verify.json", () => {
	it("skips an op with unsatisfiable params but still stamps when others pass", async () => {
		setupGuide(recipe([opBlock(OP_GET), opBlock(OP_HEALTH)].join("\n")));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain(
			"⏭ get — skipped: requires agent-supplied params (id)",
		);
		expect(text).toContain("✅ All runnable ops passed");
		expect(readGuide()).toContain(`verified: ${TODAY()}`);
	});

	it("runs a skipped op when verify.json supplies its params", async () => {
		setupGuide(recipe([opBlock(OP_GET), opBlock(OP_HEALTH)].join("\n")), {
			verifyJson: JSON.stringify({ get: { id: "42" } }),
		});
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("✓ get — /thing/{id} (restGet)");
		expect(text).toContain("✅ All runnable ops passed");
		expect(requestedUrls().some((u) => u.includes("/thing/42"))).toBe(true);
	});

	it("verify.json value wins over the op's param default", async () => {
		setupGuide(recipe(opBlock(OP_SEARCH_DEFAULT)), {
			verifyJson: JSON.stringify({ search: { q: "y" } }),
		});
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("✅ All runnable ops passed");
		expect(requestedUrls().some((u) => u.includes("q=y"))).toBe(true);
		expect(requestedUrls().some((u) => u.includes("q=all"))).toBe(false);
	});

	it("reports a malformed verify.json as a load error and skips (no crash)", async () => {
		setupGuide(recipe(opBlock(OP_GET)), { verifyJson: "{ not json" });
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("verify.json for 'verify' is malformed");
		expect(text).toContain("⚠ NOT stamped — all ops skipped");
	});

	it("verifies a passthrough op with undeclared keys from verify.json", async () => {
		setupGuide(recipe(opBlock(OP_QUERY)), {
			verifyJson: JSON.stringify({ query: { foo: "bar" } }),
		});
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("✓ query — /query (restGet)");
		expect(text).toContain("✅ All runnable ops passed");
		expect(requestedUrls().some((u) => u.includes("foo=bar"))).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════
// requiresAnyOf
// ═══════════════════════════════════════════════════════════════════

describe("/api verify — requiresAnyOf", () => {
	it("skips a required-no-default op when no sidecar value exists", async () => {
		setupGuide(recipe(opBlock(OP_SEARCH_REQUIRED)));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain(
			"⏭ search — skipped: requires agent-supplied params (q)",
		);
		expect(text).toContain("⚠ NOT stamped — all ops skipped");
		expect(requestedUrls()).toHaveLength(0);
	});

	it("skips a requiresAnyOf op when no member is supplied, naming the group", async () => {
		setupGuide(recipe(opBlock(OP_GROUP)));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain(
			"⏭ group — skipped: requires agent-supplied params (one of: id, slug, code)",
		);
		expect(text).toContain("⚠ NOT stamped — all ops skipped");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Helper-disabled + transform
// ═══════════════════════════════════════════════════════════════════

describe("/api verify — helper-disabled + transform", () => {
	it("skips (not fails) an op whose local helper is session-disabled", async () => {
		setupGuide(recipe([opBlock(OP_HELPER), opBlock(OP_HEALTH)].join("\n")), {
			helper: { content: FIXTURE_CALL_ERROR },
		});
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain(
			"⏭ helperOp — skipped: local helper disabled this session",
		);
		expect(text).toContain("✅ All runnable ops passed");
		expect(readGuide()).toContain(`verified: ${TODAY()}`);
	});

	it("treats a transform failure as non-blocking (op counts as pass)", async () => {
		setupGuide(recipe([opBlock(OP_TRANSFORM), opBlock(OP_HEALTH)].join("\n")), {
			helper: { content: FIXTURE_TRANSFORM_THROWS },
		});
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test", ctx);

		const text = notifyText(ctx);
		expect(text).toContain(
			"✓ transformOp — /transform (restGet) — transform warning: boom",
		);
		expect(text).toContain("✅ All runnable ops passed");
		expect(readGuide()).toContain(`verified: ${TODAY()}`);
	});
});
