/**
 * Post-response transform for `via: restGet`, mocked at the transport
 * layer (mirrors axis-units.test.ts — no network).
 *
 * Covers the restGet hookpoint + the `loadTransform` loader:
 *  - transform shapes data; a throwing transform warns + keeps raw data,
 *    with NO disable state (a second call re-attempts).
 *  - op.transform omitted → restGet behaves as before (no transform).
 *  - transform returning undefined/null is returned as-is.
 *  - loadTransform resolves the named `transform` export or returns null.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../core/transport.js")>(
		"../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { loadApiGuidesFromDir } from "../core/parse-api-guide.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { restGet } from "../core/helpers.js";
import { loadTransform } from "../core/local-helpers.js";
import type { ApiGuide, Operation } from "../core/api-guide-types.js";

// ── Fixtures ────────────────────────────────────────────────────────

const BODY = JSON.stringify({ rows: [{ a: 1 }, { b: 2 }] });

const FIXTURE_TRANSFORM_OK = `export function transform(data) {
  return { ...data, rows: data.rows.map((x) => ({ ...x, shaped: true })) };
};
`;

const FIXTURE_TRANSFORM_THROW = `export function transform() {
  throw new Error("boom");
};
`;

const FIXTURE_NO_NAMED = `export const foo = 42;
`;

/** Guide with a single `via: restGet` op; `transform` only when set. */
function makeRecipe(transform?: boolean): string {
	const transformLine =
		transform === undefined ? "" : `    transform: ${transform}\n`;
	return `---
kind: api
domains: [fixture.test]
icon: 📡
shortName: Fixture
updated: 2026-07-17
apiHost: https://fixture.test
verified: 2026-07-17
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: get
    via: restGet
    path: /items
    accept: json
${transformLine}    params:
      q:
        default: all
---
Fixture transform guide.
`;
}

// ── Setup helpers ────────────────────────────────────────────────

let tmpDir: string;

/** Write a guide (+ optional helper) under <guidesDir>/<domain>/ and point the store at it. */
function setupGuides(
	helper: { filename: string; content: string } | null = null,
	transform: boolean | undefined = true,
): { op: Operation; guide: ApiGuide } {
	const guidesDir = mkdtempSync(join(tmpDir, "guides-"));
	const domainDir = join(guidesDir, "fixture");
	mkdirSync(domainDir, { recursive: true });
	writeFileSync(join(domainDir, "guide.md"), makeRecipe(transform), "utf-8");
	if (helper) {
		writeFileSync(join(domainDir, helper.filename), helper.content, "utf-8");
	}

	setUserGuidesDir(guidesDir);
	invalidateCache();
	const loaded = loadApiGuidesFromDir(guidesDir);
	const guide = loaded.guides["fixture"]!;
	const op = guide.operations.find((o) => o.name === "get")!;
	return { op, guide };
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-host-transform-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadTransform", () => {
	it("returns the named `transform` export when helper.mjs has one", async () => {
		setupGuides({ filename: "helper.mjs", content: FIXTURE_TRANSFORM_OK });
		const fn = await loadTransform("fixture");
		expect(typeof fn).toBe("function");
		expect(
			fn!({ rows: [] }, { operation: "get", domain: "fixture.test" }),
		).toEqual({ rows: [] });
	});

	it("returns null when helper file is missing", async () => {
		setupGuides(null);
		expect(await loadTransform("fixture")).toBeNull();
	});

	it("returns null when the helper has no named transform export", async () => {
		setupGuides({ filename: "helper.mjs", content: FIXTURE_NO_NAMED });
		expect(await loadTransform("fixture")).toBeNull();
	});
});

describe("restGet post-response transform hookpoint", () => {
	it("returns the transformed data on success", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { op, guide } = setupGuides({
			filename: "helper.mjs",
			content: FIXTURE_TRANSFORM_OK,
		});
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: BODY,
			cached: false,
		});

		const transformFn = await loadTransform("fixture");
		const result = await restGet(
			"https://fixture.test",
			op,
			{},
			guide,
			undefined,
			transformFn ?? undefined,
			"fixture",
		);

		expect(result.data).toEqual({
			rows: [
				{ a: 1, shaped: true },
				{ b: 2, shaped: true },
			],
		});
		expect(result.transformWarning).toBeUndefined();
	});

	it("warns and keeps raw data when the transform throws, and re-attempts (no disable)", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { op, guide } = setupGuides({
			filename: "helper.mjs",
			content: FIXTURE_TRANSFORM_THROW,
		});
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: BODY,
			cached: false,
		});

		const transformFn = await loadTransform("fixture");
		const spy = vi.fn((d: unknown) =>
			transformFn!(d, { operation: "get", domain: "fixture.test" }),
		);

		const first = await restGet(
			"https://fixture.test",
			op,
			{},
			guide,
			undefined,
			spy,
			"fixture",
		);
		const second = await restGet(
			"https://fixture.test",
			op,
			{},
			guide,
			undefined,
			spy,
			"fixture",
		);

		// Raw body preserved on both calls; the transform was attempted twice.
		expect(first.data).toEqual({ rows: [{ a: 1 }, { b: 2 }] });
		expect(first.transformWarning).toBe("boom");
		expect(second.data).toEqual(first.data);
		expect(second.transformWarning).toBe("boom");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("no transformFn → raw data, no warning (op.transform omitted path)", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { op, guide } = setupGuides(null, false);
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: BODY,
			cached: false,
		});

		const result = await restGet("https://fixture.test", op, {}, guide);

		expect(result.data).toEqual({ rows: [{ a: 1 }, { b: 2 }] });
		expect(result.transformWarning).toBeUndefined();
	});

	it("returns undefined and null as the result data", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		const { op, guide } = setupGuides(null, true);
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: BODY,
			cached: false,
		});

		const undef = await restGet(
			"https://fixture.test",
			op,
			{},
			guide,
			undefined,
			() => undefined,
			"fixture",
		);
		const nul = await restGet(
			"https://fixture.test",
			op,
			{},
			guide,
			undefined,
			() => null,
			"fixture",
		);

		expect(undef.data).toBeUndefined();
		expect(nul.data).toBeNull();
	});
});
