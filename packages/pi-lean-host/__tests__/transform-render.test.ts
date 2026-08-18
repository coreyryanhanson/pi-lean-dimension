/**
 * Post-response transform *rendering* through the full `api-fetch` tool
 * execute path (mirrors axis-units.test.ts — no network).
 *
 * The hookpoint tests (`transform-restget.test.ts`, `transform-paginate.test.ts`)
 * cover `restGet`/`paginate` directly and assert `transformWarning` /
 * `failedItems` on the result objects. This file covers the `api-fetch.ts`
 * rendering layer:
 *  - the `⚠ Transform failed: <err>. Returning raw response.` prefix
 *    prepended to a restGet result whose transform threw.
 *  - the `⠂ N item(s) failed transform (raw, untransformed):` section
 *    appended to a paginate result with non-empty `failedItems`.
 *
 * Plus positive render cases: a succeeding transform shapes the rendered
 * output, so the prefix/section absence is also asserted (not just present).
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

import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import {
	apiFetchTool,
	__test__setBypassUrlSafety,
} from "../tools/api-fetch.js";
import { contentText } from "../tools/utils.js";

// ── Fixtures ────────────────────────────────────────────────────────

const RESTGET_BODY = JSON.stringify({ rows: [{ a: 1 }, { b: 2 }] });

const FIXTURE_TRANSFORM_SHAPES = `export function transform(data) {
  return { ...data, rows: data.rows.map((x) => ({ ...x, shaped: true })) };
};
`;

const FIXTURE_TRANSFORM_THROWS = `export function transform() {
  throw new Error("boom");
};
`;

/** restGet guide; `transform` only when set. */
function restGetRecipe(transform?: boolean): string {
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
Fixture transform restGet guide.
`;
}

const PAGE1 = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], next: "/page2" };
const PAGE2 = { items: [{ id: 4 }, { id: 5 }], next: null };

/** paginate (nextLink) guide; `transform` only when set. */
function paginateRecipe(transform?: boolean): string {
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
gatherAllMax: 500
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: list
    via: paginate
    path: /items
    accept: json
${transformLine}    pagination:
      style: nextLink
      itemsPath: items
      nextLinkPath: next
    params:
      q:
        default: all
---
Fixture transform paginate guide.
`;
}

/** Helper that throws on id === 3, shapes the rest. */
const FIXTURE_TRANSFORM_THROWS_ON_THREE = `export function transform(item) {
  if (item && item.id === 3) throw new Error("boom3");
  return { ...item, t: true };
};
`;

const FIXTURE_TRANSFORM_SHAPES_ALL = `export function transform(item) {
  return { ...item, t: true };
};
`;

// ── Setup helpers ──────────────────────────────────────────────────

let tmpDir: string;

function setupGuide(
	recipe: string,
	helper: { filename: string; content: string } | null,
): void {
	const guidesDir = mkdtempSync(join(tmpDir, "guides-"));
	const domainDir = join(guidesDir, "fixture.test");
	mkdirSync(domainDir, { recursive: true });
	writeFileSync(join(domainDir, "guide.md"), recipe, "utf-8");
	if (helper) {
		writeFileSync(join(domainDir, helper.filename), helper.content, "utf-8");
	}
	setUserGuidesDir(guidesDir);
	invalidateCache();
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-host-transform-render-"));
	__test__setBypassUrlSafety(true);
});

afterAll(() => {
	__test__setBypassUrlSafety(false);
	rmSync(tmpDir, { recursive: true, force: true });
});

// ── restGet render layer ───────────────────────────────────────────

describe("api-fetch restGet transform rendering", () => {
	it("prepends the ⚠ Transform failed prefix and renders raw data when the transform throws", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		setupGuide(restGetRecipe(true), {
			filename: "helper.mjs",
			content: FIXTURE_TRANSFORM_THROWS,
		});
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: RESTGET_BODY,
			cached: false,
		});

		const text = contentText(
			await apiFetchTool.execute(
				"test",
				{ domain: "fixture.test", operation: "get" },
				undefined,
				undefined,
				undefined as any,
			),
		);

		// The prefix is the first line.
		expect(
			text.startsWith("⚠ Transform failed: boom. Returning raw response."),
		).toBe(true);
		// Raw body is rendered verbatim underneath the prefix.
		expect(text).toContain('"a": 1');
		expect(text).toContain('"b": 2');
		// No shaping leaked through.
		expect(text).not.toContain("shaped");
	});

	it("renders shaped data and omits the prefix when the transform succeeds", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		setupGuide(restGetRecipe(true), {
			filename: "helper.mjs",
			content: FIXTURE_TRANSFORM_SHAPES,
		});
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: {},
			body: RESTGET_BODY,
			cached: false,
		});

		const text = contentText(
			await apiFetchTool.execute(
				"test",
				{ domain: "fixture.test", operation: "get" },
				undefined,
				undefined,
				undefined as any,
			),
		);

		expect(text).not.toContain("⚠ Transform failed");
		expect(text).toContain('"shaped": true');
	});
});

// ── paginate render layer ──────────────────────────────────────────

describe("api-fetch paginate transform rendering", () => {
	it("appends the ⠂ failed-transform section with the raw failed item when one item throws", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		setupGuide(paginateRecipe(true), {
			filename: "helper.mjs",
			content: FIXTURE_TRANSFORM_THROWS_ON_THREE,
		});
		vi.mocked(fetchUrl).mockImplementation(async (url) => ({
			status: 200,
			headers: {},
			body: JSON.stringify(String(url).includes("/page2") ? PAGE2 : PAGE1),
			cached: false,
		}));

		const text = contentText(
			await apiFetchTool.execute(
				"test",
				{
					domain: "fixture.test",
					operation: "list",
					gatherAll: true,
				},
				undefined,
				undefined,
				undefined as any,
			),
		);

		// The ⠂ section header names the count.
		expect(text).toContain(
			"⠂ 1 item(s) failed transform (raw, untransformed):",
		);
		// The raw failed item appears in the section.
		expect(text).toContain('"id": 3');
		// Transformed items carry the shaped flag.
		expect(text).toContain('"t": true');
	});

	it("omits the ⠂ section when all items transform successfully", async () => {
		const { fetchUrl } = await import("../core/transport.js");
		setupGuide(paginateRecipe(true), {
			filename: "helper.mjs",
			content: FIXTURE_TRANSFORM_SHAPES_ALL,
		});
		vi.mocked(fetchUrl).mockImplementation(async (url) => ({
			status: 200,
			headers: {},
			body: JSON.stringify(String(url).includes("/page2") ? PAGE2 : PAGE1),
			cached: false,
		}));

		const text = contentText(
			await apiFetchTool.execute(
				"test",
				{
					domain: "fixture.test",
					operation: "list",
					gatherAll: true,
				},
				undefined,
				undefined,
				undefined as any,
			),
		);

		expect(text).not.toContain("failed transform");
		expect(text).toContain('"t": true');
	});
});
