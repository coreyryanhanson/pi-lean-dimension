/**
 * Agent-facing tools tests.
 *
 * Covers the acceptance criteria:
 *  - Full write→verify→fix loop against local test server.
 *  - api-guide({}) catalog and api-guide({domain}) detail shapes.
 *  - api-learn validate-before-write (no half-write on invalid recipe).
 *  - api-fetch execute-fail message points at remediation paths.
 *  - api-learn with no domain returns the authoring manual.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Tools ────────────────────────────────────────────────────────
import { apiGuideTool } from "../tools/api-guide.js";
import { contentText } from "../tools/utils.js";
import {
	apiFetchTool,
	__test__setBypassUrlSafety,
} from "../tools/api-fetch.js";
import { apiLearnTool } from "../tools/api-learn.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { parseApiGuide } from "../core/parse-api-guide.js";

// ═══════════════════════════════════════════════════════════════════
// Test server for API endpoints
// ═══════════════════════════════════════════════════════════════════

interface TestCtx {
	serverUrl: string;
	stop: () => Promise<void>;
}

async function createApiTestServer(): Promise<TestCtx> {
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const pathname = url.pathname;

		// GET /diario/{date} — searchDiary equivalent
		if (pathname.startsWith("/diario/")) {
			const date = pathname.split("/").pop();
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=60",
			});
			res.end(
				JSON.stringify({
					data: [
						{ id: 1, fecha: date, titulo: "Disposición 1" },
						{ id: 2, fecha: date, titulo: "Disposición 2" },
					],
					total: 2,
				}),
			);
			return;
		}

		// GET /legislacion-consolidada — paginated list
		if (pathname === "/legislacion-consolidada") {
			const cursor = url.searchParams.get("cursor") ?? "";
			if (cursor === "done") {
				res.writeHead(200, {
					"Content-Type": "application/json",
				});
				res.end(
					JSON.stringify({
						results: [],
						totalCount: 50,
						pagination: { nextCursor: null },
					}),
				);
				return;
			}
			res.writeHead(200, {
				"Content-Type": "application/json",
			});
			res.end(
				JSON.stringify({
					results: [
						{ id: 1, titulo: "Ley 1" },
						{ id: 2, titulo: "Ley 2" },
					],
					totalCount: 50,
					pagination: { nextCursor: cursor === "page2" ? "done" : "page2" },
				}),
			);
			return;
		}

		// GET /large-response — returns a JSON body > 4000 chars to trigger spill
		if (pathname === "/large-response") {
			res.writeHead(200, { "Content-Type": "application/json" });
			const largeData = {
				results: Array.from({ length: 200 }, (_, i) => ({
					id: i,
					title: `Item ${i} with some padding text to make each entry longer than a few characters so we cross the 4000-char truncation threshold easily`,
				})),
				total: 200,
			};
			res.end(JSON.stringify(largeData));
			return;
		}

		// 404
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	};

	const { url, stop } = await startTestServer(handler);
	return { serverUrl: url, stop };
}

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

/** A valid recipe for the BOE-style test server. */
function boeRecipe(apiHost: string): string {
	return `---
kind: api
domains: [boe.es, www.boe.es]
icon: ⚖️
shortName: BOE
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

pagination:
  style: cursor
  cursorParam: cursor
  cursorPath: pagination.nextCursor
  itemsPath: results

responseShape:
  format: json
  charset: utf-8

operations:
  - name: searchDiary
    via: restGet
    path: /diario/{date}
    accept: json
    params:
      limit:
        default: 50

  - name: listConsolidada
    via: paginate
    path: /legislacion-consolidada
    accept: json
---
Guide prose.
`;
}

/** Recipe for a guide with param spec annotations. */
function paramsRecipe(apiHost: string): string {
	return `---
kind: api
domains: [params.example]
icon: 📋
shortName: Params
updated: 2026-07-17
apiHost: ${apiHost}
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
    params:
      q:
        required: true
      limit:
        default: 50
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
      itemsPath: data
---
Param spec test guide.
`;
}

/** Recipe whose params carry `description` hints (format / semantics). */
function descRecipe(apiHost: string): string {
	return `---
kind: api
domains: [desc.example]
icon: 📝
shortName: Desc
updated: 2026-07-17
apiHost: ${apiHost}
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
    params:
      q:
        required: true
        description: Full-text search term; multi-word phrases are quoted.
      fecha:
        description: Date in YYYYMMDD form (a full day, not month-level).
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
      itemsPath: data

  - name: get
    via: restGet
    path: /items/{fecha}
    accept: json
    params:
      fecha:      # docs-only — {fecha} is a path token, never a query param
        description: Exact item date, YYYYMMDD form (a full day).
---
Date format: all dates are YYYYMMDD. Use titulo: for title search.
`;
}

/** Recipe for a guide with op-level pagination but no guide-level pagination. */
function pagedRecipe(apiHost: string): string {
	return `---
kind: api
domains: [paged.example]
icon: 📄
shortName: Paged
updated: 2026-07-17
apiHost: ${apiHost}
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
    params:
      q:
        required: true
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
      base: 1
      itemsPath: data
---
Pagination test guide.
`;
}

/** Recipe for testing guide-level pagination fallback. */
function pagFallbackRecipe(apiHost: string): string {
	return `---
kind: api
domains: [pagination-fallback.example]
icon: 🔄
shortName: PagFallback
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

pagination:
  style: cursor
  cursorParam: cursor
  cursorPath: pagination.nextCursor
  itemsPath: results

responseShape:
  format: json
  charset: utf-8

operations:
  - name: getOp
    via: paginate
    path: /items
    accept: json
    # no op-level pagination — inherits guide-level cursor

  - name: getOther
    via: restGet
    path: /other
    accept: json
---
Pagination fallback test guide.
`;
}

/** Recipe for gatherAll robustness tests — a passthrough paginate op (so a
 * leaked `gatherAll` would be visible on the query string) and a restGet op. */
function gatherAllRecipe(apiHost: string): string {
	return `---
kind: api
domains: [gather.example]
icon: 🧲
shortName: Gather
updated: 2026-07-17
apiHost: ${apiHost}
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
    path: /legislacion-consolidada
    accept: json
    passthrough: true
    pagination:
      style: cursor
      cursorParam: cursor
      cursorPath: pagination.nextCursor
      itemsPath: results
      totalCountPath: totalCount

  - name: getDiary
    via: restGet
    path: /diario/{date}
    accept: json
    params:
      limit:
        default: 50
---
GatherAll robustness test guide.
`;
}

/** Two guides claiming the same domain (shared.example) — disambiguation fixtures. */
function sharedRestRecipe(apiHost: string): string {
	return `---
kind: api
domains: [shared.example]
organization: shared.org
description: REST surface for the shared domain.
icon: 🌐
shortName: SharedRest
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

responseShape:
  format: json
  charset: utf-8

operations:
  - name: getDiary
    via: restGet
    path: /diario/{date}
    accept: json
    params:
      limit:
        default: 50

  - name: restOnly
    via: restGet
    path: /diario/{date}
    accept: json
---
Shared REST guide.
`;
}

function sharedActionRecipe(apiHost: string): string {
	return `---
kind: api
domains: [shared.example]
organization: shared.org
description: Action surface for the shared domain.
icon: 🛠️
shortName: SharedAction
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

pagination:
  style: cursor
  cursorParam: cursor
  cursorPath: pagination.nextCursor
  itemsPath: results

responseShape:
  format: json
  charset: utf-8

operations:
  - name: listConsolidada
    via: paginate
    path: /legislacion-consolidada
    accept: json

  - name: actionOnly
    via: restGet
    path: /diario/{date}
    accept: json
---
Shared Action guide.
`;
}

/** One-op guide on collide.example — parametrized for shortName/op-name collision tests. */
function collideRecipe(
	apiHost: string,
	shortName: string,
	opName: string,
): string {
	return `---
kind: api
domains: [collide.example]
icon: 🔼
shortName: ${shortName}
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

responseShape:
  format: json
  charset: utf-8

operations:
  - name: ${opName}
    via: restGet
    path: /diario/{date}
    accept: json
---
Collide guide.
`;
}

/** One-op guide on opcollide.example whose single op is `fetchThing` — for the ambiguous-op test. */
function opCollideRecipe(apiHost: string, shortName: string): string {
	return `---
kind: api
domains: [opcollide.example]
icon: 🔼
shortName: ${shortName}
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

responseShape:
  format: json
  charset: utf-8

operations:
  - name: fetchThing
    via: restGet
    path: /diario/{date}
    accept: json
---
Op-collide guide.
`;
}

/** An invalid recipe (missing leading / in path). */
const INVALID_RECIPE = `---
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: things/{id}
---
body
`;

// ═══════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════

let ctx: TestCtx;
let tmpGuidesDir: string;
let tmpDir: string;

beforeAll(async () => {
	ctx = await createApiTestServer();
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-guides-tools-"));
	setUserGuidesDir(tmpGuidesDir);
	invalidateCache();
	__test__setBypassUrlSafety(true);

	// Isolated temp dir for spill tests
	tmpDir = mkdtempSync(join(tmpdir(), "host-spill-test-"));
	process.env.PI_HOST_TEMP_DIR = tmpDir;
});

afterAll(async () => {
	delete process.env.PI_HOST_TEMP_DIR;
	await ctx.stop();
	rmSync(tmpGuidesDir, { recursive: true, force: true });
	rmSync(tmpDir, { recursive: true, force: true });
	__test__setBypassUrlSafety(false);
});

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function callGuide(domain?: string) {
	return apiGuideTool.execute(
		"test",
		domain ? { domain } : {},
		undefined,
		undefined,
		undefined as any,
	);
}

function callFetch(
	params: {
		domain: string;
		operation: string;
		params?: Record<string, unknown>;
		gatherAll?: boolean;
	},
	ctx?: any,
) {
	return apiFetchTool.execute(
		"test",
		params,
		undefined,
		undefined,
		ctx ?? (undefined as any),
	);
}

function callLearn(
	domain?: string,
	recipe?: string,
	extra?: { new?: boolean; guide?: string },
) {
	const p: Record<string, unknown> = {};
	if (domain !== undefined) p.domain = domain;
	if (recipe !== undefined) p.recipe = recipe;
	if (extra?.new !== undefined) p.new = extra.new;
	if (extra?.guide !== undefined) p.guide = extra.guide;
	return apiLearnTool.execute("test", p, undefined, undefined, undefined as any);
}

// ═══════════════════════════════════════════════════════════════════
// api-guide — catalog & detail
// ═══════════════════════════════════════════════════════════════════

describe("api-guide", () => {
	it("returns empty catalog when no guides are installed", async () => {
		const text = contentText(await callGuide());
		expect(text).toContain("no guides");
		expect(text).toContain("api-learn");
	});

	it("returns an informative error for an unknown domain", async () => {
		const text = contentText(await callGuide("unknown.example"));
		expect(text).toContain("No API guide");
		expect(text).toContain("unknown.example");
		expect(text).toContain("api-learn");
	});

	it("shows guide detail after a guide is written", async () => {
		const learnText = contentText(
			await callLearn("boe.es", boeRecipe(ctx.serverUrl)),
		);
		expect(learnText).toContain("Guide saved");
		invalidateCache();

		const text = contentText(await callGuide("boe.es"));
		expect(text).toContain("BOE");
		expect(text).toContain("searchDiary");
		expect(text).toContain("listConsolidada");
		expect(text).toContain(ctx.serverUrl);
		expect(text).toContain("Auth:");
		expect(text).toContain("none");
	});

	it("lists the guide in the catalog", async () => {
		const text = contentText(await callGuide());
		expect(text).toContain("BOE");
		expect(text).toContain("boe.es");
	});

	it("includes the current date in the guide footer", async () => {
		const text = contentText(await callGuide("boe.es"));
		const today = new Date().toISOString().slice(0, 10);
		expect(text).toContain(today);
	});

	it("renders param specs (required, default) in op detail", async () => {
		await callLearn("params.example", paramsRecipe(ctx.serverUrl));
		invalidateCache();
		const text = contentText(await callGuide("params.example"));
		expect(text).toContain("params: q required");
		expect(text).toContain("limit default 50");
	});

	it("surfaces param descriptions and guide prose in op detail", async () => {
		await callLearn("desc.example", descRecipe(ctx.serverUrl));
		invalidateCache();
		const text = contentText(await callGuide("desc.example"));
		// Per-param hints reach the model...
		expect(text).toContain("q: Full-text search term");
		expect(text).toContain("fecha: Date in YYYYMMDD form");
		// ...path-param docs render next to the path line...
		expect(text).toMatch(/{fecha}: Exact item date/);
		// ...and so does the guide's prose (date format / field semantics).
		expect(text).toContain("— Guide notes —");
		expect(text).toContain("Date format: all dates are YYYYMMDD");
		expect(text).toContain("titulo: for title search");
	});

	it("renders pagination page size and falls back to guide-level config", async () => {
		await callLearn(
			"pagination-fallback.example",
			pagFallbackRecipe(ctx.serverUrl),
		);
		invalidateCache();
		const text = contentText(await callGuide("pagination-fallback.example"));
		// getOp has no op-level pagination; guide-level cursor should show
		expect(text).toContain("pagination: cursor");
		// getOther is restGet — no pagination line after its name
		const lines = text.split("\n");
		const getOtherIdx = lines.findIndex((l) => l.includes("getOther"));
		const sectionLines = lines.slice(getOtherIdx, getOtherIdx + 6);
		const hasPagLine = sectionLines.some((l) =>
			l.trimStart().startsWith("pagination:"),
		);
		expect(hasPagLine).toBe(false);
	});

	it("renders op-level pagination with pageSizeParam and pageSize", async () => {
		await callLearn("paged.example", pagedRecipe(ctx.serverUrl));
		invalidateCache();
		const text = contentText(await callGuide("paged.example"));
		expect(text).toContain("pagination: offset-limit offset");
		expect(text).toContain("limit=50");
		expect(text).toContain("base=1");
		expect(text).toContain("params: q required");
	});
});

// ═══════════════════════════════════════════════════════════════════
// api-learn — validate, write, no-half-write, example
// ═══════════════════════════════════════════════════════════════════

describe("api-learn", () => {
	it("returns the authoring manual when no domain is given", async () => {
		const text = contentText(await callLearn());
		expect(text).toContain("authoring manual");
		// Field reference + defaults + semantics stay.
		expect(text).toContain("Required fields");
		expect(text).toContain("Key defaults");
		expect(text).toContain("Executor semantics");
		expect(text).toContain("joinUrl` strips a leading `/");
		expect(text).toContain("pagination.base` seeds the page param");
		expect(text).toContain("page-size param is a real knob");
		expect(text).toContain("requires` = fail-closed if unprovisioned");
		// Guide-prose (agent-instructions) ability is taught, not lost.
		expect(text).toContain("Guide prose");
		expect(text).toContain("Guide notes");
		// Points at the template entry point; no recipe body.
		expect(text).toContain("new: true");
		expect(text).not.toContain("searchDiary");
		expect(text).not.toContain("```yaml");
	});

	// Gap 1: the template is a placeholder skeleton, not a worked example. It
	// must fail closed (placeholder apiHost rejected) and carry no foreign API
	// literals. The dateParams/path-token-doc demonstration moved to the
	// probe-scaffold path (api-probe({scaffold: true}) emits real ops).
	it("template is a placeholder skeleton that fails closed", async () => {
		const text = contentText(
			await callLearn("example.com", undefined, { new: true }),
		);
		const m = text.match(/```yaml\n([\s\S]*?)```/);
		expect(m).not.toBeNull();
		const template = m![1]!;
		expect(template).toContain("domains: [example.com]");
		expect(template).toContain("<base url>");
		expect(template).toContain("<short>");
		expect(template).toContain("<emoji>");
		expect(template).not.toMatch(
			/apidatos|boe\.es|BOE|searchDiary|listConsolidada/,
		);
		// The prose-body (agent-instructions) ability is surfaced, not lost.
		expect(template).toContain("agent-instruction prose");
		expect(template).toContain("the closing ---");
		// Fail-closed: the as-is template cannot save (placeholder apiHost
		// is rejected by requireHttpUrl).
		expect(parseApiGuide(template, { filename: "example.com" }).ok).toBe(false);
	});

	it("validates and writes a valid recipe", async () => {
		const text = contentText(await callLearn("boe.es", boeRecipe(ctx.serverUrl)));
		expect(text).toContain("Guide saved");
		expect(text).toContain("boe.es");
		expect(text).toContain("searchDiary");
		expect(text).toContain("api-fetch");

		const filepath = join(tmpGuidesDir, "boe.es", "guide.md");
		const content = readFileSync(filepath, "utf-8");
		expect(content).toContain("apiHost:");
	});

	it("rejects an invalid recipe without writing", async () => {
		setUserGuidesDir(tmpGuidesDir);
		const text = contentText(await callLearn("broken", INVALID_RECIPE));
		expect(text).toContain("Validation error");
		expect(text).toContain("operations[0].path");
		expect(text).toContain("NOT saved");

		const filepath = join(tmpGuidesDir, "broken", "guide.md");
		expect(() => readFileSync(filepath, "utf-8")).toThrow();
	});

	// Gap 2: a validation failure names the manual section governing the
	// failing field, so a first-time author who wrote from memory is routed
	// to the manual instead of re-guessing. auth.* → Auth, operations[*].via
	// → Required fields, unmapped fields → generic manual pointer.
	it("routes validation failures to the governing manual section (gap 2)", async () => {
		setUserGuidesDir(tmpGuidesDir);

		// Gap 1's wrong-auth shape → Auth section.
		const authText = contentText(
			await callLearn(
				"authbad.example",
				`---
domains: [authbad.example]
apiHost: https://api.example.com
auth:
  kind: static-key
  name: X-CMC_PRO_API_KEY
  secret: api_key
operations:
  - name: get
    via: restGet
    path: /things
---
`,
			),
		);
		expect(authText).toContain("auth.name");
		expect(authText).toContain("`Auth` section of the authoring manual");

		// Bad via → Required fields.
		const viaText = contentText(
			await callLearn(
				"viabad.example",
				`---
domains: [viabad.example]
apiHost: https://api.example.com
operations:
  - name: get
    via: post
    path: /things
---
`,
			),
		);
		expect(viaText).toContain("operations[0].via");
		expect(viaText).toContain(
			"`Required fields` section of the authoring manual",
		);

		// Unmapped field (frontmatter) → generic manual pointer.
		const fmText = contentText(await callLearn("fmbad.example", "just prose"));
		expect(fmText).toContain("frontmatter");
		expect(fmText).toContain(
			"Call api-learn() with no params for the authoring manual",
		);
		expect(fmText).not.toContain("` section of the authoring manual");
	});

	it("returns a domain template when no recipe and no guide exists", async () => {
		const text = contentText(await callLearn("somedomain.com"));
		expect(text).toContain("```yaml");
		expect(text).toContain("domains: [somedomain.com]");
	});

	it("rejects a path-traversal domain without writing", async () => {
		// Guards assertSafeDomain at the api-learn write boundary.
		setUserGuidesDir(tmpGuidesDir);
		const result = await callLearn("../../escape", boeRecipe(ctx.serverUrl));
		const text = contentText(result);
		expect(text).toContain("Invalid domain");
		expect(result.details).toMatchObject({
			error: "invalid_domain",
			domain: "../../escape",
		});
		// Nothing written outside the guides dir.
		expect(() =>
			readFileSync(join(tmpGuidesDir, "..", "..", "escape", "guide.md"), "utf-8"),
		).toThrow();
	});

	it("rejects a description over 200 chars without writing", async () => {
		// Strict-on-write: the parser accepts any length (lenient-on-read),
		// but api-learn rejects >200 before writing.
		setUserGuidesDir(tmpGuidesDir);
		const longDesc = "x".repeat(201);
		const recipe = `---
kind: api
domains: [toolong.example]
description: ${longDesc}
apiHost: ${ctx.serverUrl}
operations:
  - name: get
    via: restGet
    path: /x
    accept: json
---
`;
		const result = await callLearn("toolong.example", recipe);
		const text = contentText(result);
		expect(text).toContain("NOT saved");
		expect(text).toContain("description");
		expect(text).toContain("201");
		expect(result.details).toMatchObject({ error: "description_too_long" });
		expect(() =>
			readFileSync(join(tmpGuidesDir, "toolong.example", "guide.md"), "utf-8"),
		).toThrow();
	});

	it("accepts a description at exactly 200 chars", async () => {
		setUserGuidesDir(tmpGuidesDir);
		const desc = "x".repeat(200);
		const recipe = `---
kind: api
domains: [boundary.example]
description: ${desc}
apiHost: ${ctx.serverUrl}
operations:
  - name: get
    via: restGet
    path: /x
    accept: json
---
`;
		const text = contentText(await callLearn("boundary.example", recipe));
		expect(text).toContain("Guide saved");
	});

	it("warns (does not reject) when domains collide with another guide", async () => {
		// Two guides, same `domains:` key, different directories. Valid — that's
		// the multi-recipe point. The write succeeds with a warning.
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const first = `---
kind: api
domains: [collide.example]
organization: collide.org
description: First surface.
shortName: First
apiHost: ${ctx.serverUrl}
operations:
  - name: getFirst
    via: restGet
    path: /x
    accept: json
---
`;
		const second = `---
kind: api
domains: [collide.example]
organization: collide.org
description: Second surface.
shortName: Second
apiHost: ${ctx.serverUrl}
operations:
  - name: getSecond
    via: restGet
    path: /x
    accept: json
---
`;
		const firstText = contentText(await callLearn("collide-first", first));
		expect(firstText).toContain("Guide saved");
		expect(firstText).not.toContain("Multi-recipe");
		invalidateCache();
		const secondText = contentText(await callLearn("collide-second", second));
		expect(secondText).toContain("Guide saved");
		expect(secondText).toContain("Multi-recipe");
		expect(secondText).toContain("collide-second");
		expect(secondText).toContain("collide.example");
	});

	it("warns about a missing description when colliding", async () => {
		// When the second guide collides and omits description:, api-learn
		// recommends adding one (the primary disambiguation signal).
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const first = `---
kind: api
domains: [nodesc.example]
organization: nodesc.org
description: First surface.
shortName: First
apiHost: ${ctx.serverUrl}
operations:
  - name: getFirst
    via: restGet
    path: /x
    accept: json
---
`;
		const second = `---
kind: api
domains: [nodesc.example]
organization: nodesc.org
shortName: Second
apiHost: ${ctx.serverUrl}
operations:
  - name: getSecond
    via: restGet
    path: /x
    accept: json
---
`;
		await callLearn("nodesc-first", first);
		invalidateCache();
		const text = contentText(await callLearn("nodesc-second", second));
		expect(text).toContain("Guide saved");
		expect(text).toContain("Multi-recipe");
		expect(text).toContain("description");
		expect(text).toContain("recommended");
	});

	it("collision warning names /api delete as the recovery gesture", async () => {
		// The agent has no delete tool — when an existing guide is wrong, the
		// collision warning must point at the human-typed /api delete command,
		// naming the colliding directory (the one to remove).
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const first = `---
kind: api
domains: [recover.example]
organization: recover.org
shortName: First
apiHost: ${ctx.serverUrl}
operations:
  - name: getFirst
    via: restGet
    path: /x
    accept: json
---
`;
		const second = `---
kind: api
domains: [recover.example]
organization: recover.org
shortName: Second
apiHost: ${ctx.serverUrl}
operations:
  - name: getSecond
    via: restGet
    path: /x
    accept: json
---
`;
		await callLearn("recover-first", first);
		invalidateCache();
		const text = contentText(await callLearn("recover-second", second));
		expect(text).toContain("Multi-recipe");
		expect(text).toContain("/api delete recover-first");
		expect(text).toContain("the agent has no delete tool");
	});

	it("does not warn when updating the same guide's own directory", async () => {
		// Updating `foo.example` when `foo.example` already claims the domain is
		// not a collision — same dirName. No warning.
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const r1 = `---
kind: api
domains: [solo.example]
shortName: Solo
apiHost: ${ctx.serverUrl}
operations:
  - name: get
    via: restGet
    path: /x
    accept: json
---
`;
		const r2 = r1.replace("shortName: Solo", "shortName: Solo2");
		await callLearn("solo.example", r1);
		invalidateCache();
		const text = contentText(await callLearn("solo.example", r2));
		expect(text).toContain("Guide saved");
		expect(text).not.toContain("Multi-recipe");
	});

	// D6 — the template is the docs-side discoverability: no hardcoded
	// updated/verified dates (the tool stamps them when omitted — the
	// load-bearing D2 close) and a static-key auth block to crib from.
	it("template has no hardcoded updated/verified dates", async () => {
		const text = contentText(
			await callLearn("example.com", undefined, { new: true }),
		);
		const m = text.match(/```yaml\n([\s\S]*?)```/);
		expect(m).not.toBeNull();
		const example = m![1]!;
		expect(example).not.toMatch(/^updated:/m);
		expect(example).not.toMatch(/^verified:/m);
		expect(example).toContain("stamped by the tool when omitted");
	});

	it("template documents the static-key auth block", async () => {
		const text = contentText(
			await callLearn("example.com", undefined, { new: true }),
		);
		const m = text.match(/```yaml\n([\s\S]*?)```/);
		expect(m).not.toBeNull();
		const example = m![1]!;
		expect(example).toContain("kind: static-key");
		expect(example).toContain("requires: [apiKey]");
		expect(example).toContain("secretRefs:");
		expect(example).toContain("headerPrefixes:");
	});

	// D-bootstrap (write path) — api-learn stamps schemaVersion on save.
	it("stamps schemaVersion on save when the recipe omits it", async () => {
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const recipe = `---\nkind: api\ndomains: [stamp-absent.example]\nshortName: StampAbsent\napiHost: ${ctx.serverUrl}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\nProse body.\n`;
		await callLearn("stamp-absent.example", recipe);
		const raw = readFileSync(
			join(tmpGuidesDir, "stamp-absent.example", "guide.md"),
			"utf-8",
		);
		expect(raw).toMatch(/^schemaVersion: 0$/m);
		// Prose body untouched.
		expect(raw).toContain("Prose body.");
	});

	it("replaces an explicit older schemaVersion on save", async () => {
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const recipe = `---\nkind: api\nschemaVersion: 5\ndomains: [stamp-replace.example]\nshortName: StampReplace\napiHost: ${ctx.serverUrl}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		await callLearn("stamp-replace.example", recipe);
		const raw = readFileSync(
			join(tmpGuidesDir, "stamp-replace.example", "guide.md"),
			"utf-8",
		);
		expect(raw).toMatch(/^schemaVersion: 0$/m);
		expect(raw).not.toMatch(/^schemaVersion: 5$/m);
	});

	it("never touches a schemaVersion string in the prose body", async () => {
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const recipe = `---\nkind: api\ndomains: [stamp-prose.example]\nshortName: StampProse\napiHost: ${ctx.serverUrl}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\nThe schemaVersion: 5 in this prose must stay untouched.\n`;
		await callLearn("stamp-prose.example", recipe);
		const raw = readFileSync(
			join(tmpGuidesDir, "stamp-prose.example", "guide.md"),
			"utf-8",
		);
		// Frontmatter got the stamp...
		expect(raw).toMatch(/^schemaVersion: 0$/m);
		// ...and the prose line is untouched (still schemaVersion: 5).
		expect(raw).toContain(
			"The schemaVersion: 5 in this prose must stay untouched.",
		);
	});

	it("preserves comments and key order when stamping", async () => {
		setUserGuidesDir(tmpGuidesDir);
		invalidateCache();
		const recipe = `---\nkind: api\ndomains: [stamp-order.example]\n# a comment that must survive\nshortName: StampOrder\napiHost: ${ctx.serverUrl}\noperations:\n  - name: get\n    via: restGet\n    path: /x\n    accept: json\n---\n`;
		await callLearn("stamp-order.example", recipe);
		const raw = readFileSync(
			join(tmpGuidesDir, "stamp-order.example", "guide.md"),
			"utf-8",
		);
		expect(raw).toContain("# a comment that must survive");
		// Key order preserved; schemaVersion inserted after operations, before
		// the closing --- (no YAML round-trip).
		const idxDomains = raw.indexOf("domains:");
		const idxShort = raw.indexOf("shortName:");
		const idxApi = raw.indexOf("apiHost:");
		const idxOps = raw.indexOf("operations:");
		const idxSV = raw.indexOf("schemaVersion: 0");
		expect(idxDomains).toBeLessThan(idxShort);
		expect(idxShort).toBeLessThan(idxApi);
		expect(idxApi).toBeLessThan(idxOps);
		expect(idxOps).toBeLessThan(idxSV);
	});
});

/** A recipe for the large-response endpoint (spill truncation). */
function largeResponseRecipe(apiHost: string): string {
	return `---
kind: api
domains: [large.example]
icon: 📦
shortName: Large
updated: 2026-07-17
apiHost: ${apiHost}
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

responseShape:
  format: json
  charset: utf-8

operations:
  - name: getLarge
    via: restGet
    path: /large-response
    accept: json
---
Large response test guide.
`;
}

// ═══════════════════════════════════════════════════════════════════
// api-fetch — execute, paginate, error messages
// ═══════════════════════════════════════════════════════════════════

describe("api-fetch", () => {
	it("fails informingly for an unknown domain", async () => {
		const text = contentText(
			await callFetch({ domain: "unknown.example", operation: "get" }),
		);
		expect(text).toContain("No API guide");
		expect(text).toContain("unknown.example");
		expect(text).toContain("api-guide");
		expect(text).toContain("api-learn");
	});

	it("fails informingly for a missing operation", async () => {
		const text = contentText(
			await callFetch({ domain: "boe.es", operation: "nonexistent" }),
		);
		expect(text).toContain("No operation");
		expect(text).toContain("nonexistent");
		expect(text).toContain("searchDiary");
		expect(text).toContain("listConsolidada");
	});

	it("executes a restGet operation against the test server", async () => {
		const result = await callFetch({
			domain: "boe.es",
			operation: "searchDiary",
			params: { date: "2026-07-17" },
		});
		const text = contentText(result);
		expect(text).toContain("BOE");
		expect(text).toContain("searchDiary");
		expect(text).toContain("Disposición");
		expect(text).toContain("2026-07-17");

		const details = result!.details as Record<string, unknown>;
		expect(details.via).toBe("restGet");
		expect(details.domain).toBe("boe.es");
		expect(details.operation).toBe("searchDiary");
	});

	it("does not append a stale-schema note for a current guide", async () => {
		// GUIDE_SCHEMA_VERSION is 0 during beta, so a freshly-saved guide is
		// current — the staleness note must not appear on its fetch result
		// (proves the api-fetch note wiring is active without a real bump).
		const result = await callFetch({
			domain: "boe.es",
			operation: "searchDiary",
			params: { date: "2026-07-17" },
		});
		const text = contentText(result);
		expect(text).toContain("BOE");
		expect(text).not.toContain("⚠ schemaVersion");
	});

	it("executes a paginate operation against the test server", async () => {
		const result = await callFetch({
			domain: "boe.es",
			operation: "listConsolidada",
			gatherAll: true,
		});
		const text = contentText(result);
		expect(text).toContain("fetched");

		const details = result!.details as Record<string, unknown>;
		expect(details.via).toBe("paginate");
		expect(details.totalFetched).toBeTypeOf("number");
	});

	it("gathers all pages when gatherAll is nested in params and strips it from the request (A1/A3)", async () => {
		await callLearn("gather.example", gatherAllRecipe(ctx.serverUrl));
		invalidateCache();

		const result = await callFetch({
			domain: "gather.example",
			operation: "list",
			params: { gatherAll: true, extra: "x" },
		});
		const text = contentText(result);
		// Nested gatherAll walks all 3 cursor pages → 2+2 items.
		expect(text).toContain("4 item(s) fetched");

		// A3 — gatherAll must not leak onto the passthrough query string.
		const details = result!.details as Record<string, unknown>;
		const request = details.request as Record<string, unknown>;
		expect(String(request.url)).not.toContain("gatherAll");
		expect(String(request.url)).toContain("extra=x");
	});

	it("prints an ignore notice when gatherAll is set on a restGet op and still executes (A2)", async () => {
		const result = await callFetch({
			domain: "gather.example",
			operation: "getDiary",
			gatherAll: true,
			params: { date: "2026-07-17" },
		});
		const text = contentText(result);
		// Op still executes, returning the diary.
		expect(text).toContain("Disposición");
		expect(text).toContain("gatherAll ignored");
		expect(text).toContain("getDiary is not paginated");
	});

	it("prints the server total and remaining in the paginate footer when totalCountPath resolves (B3)", async () => {
		// gatherAllRecipe's `list` op declares totalCountPath: totalCount; the
		// test server reports 50 across 4 fetched items → footer shows both.
		const result = await callFetch({
			domain: "gather.example",
			operation: "list",
			gatherAll: true,
		});
		const text = contentText(result);
		expect(text).toContain("4 item(s) fetched");
		expect(text).toContain("server total: 50");
		expect(text).toContain("remaining: 46");

		const details = result!.details as Record<string, unknown>;
		expect(details.serverTotal).toBe(50);
	});

	it("omits the server total line when the guide declares no totalCountPath (B3)", async () => {
		// boeRecipe's listConsolidada declares no totalCountPath → footer stays
		// as before, no server total / remaining lines.
		const result = await callFetch({
			domain: "boe.es",
			operation: "listConsolidada",
			gatherAll: true,
		});
		const text = contentText(result);
		expect(text).not.toContain("server total");
		expect(text).not.toContain("remaining:");
	});

	it("spills large response to temp file when truncated", async () => {
		// Learn the large-response guide
		const learnText = contentText(
			await callLearn("large.example", largeResponseRecipe(ctx.serverUrl)),
		);
		expect(learnText).toContain("Guide saved");
		invalidateCache();

		// Mock session context so spill keys on a known session
		const mockCtx = {
			sessionManager: {
				getSessionId: () => "test-truncation",
			},
		};

		const result = await callFetch(
			{ domain: "large.example", operation: "getLarge" },
			mockCtx,
		);
		const text = contentText(result);

		// Inline output should contain the spill hint with a real path
		expect(text).toContain("📄 Full response");
		expect(text).toContain("written to");
		expect(text).toContain(".json");
		expect(text).toContain("read + offset/limit");
		expect(text).toContain("offset/limit");

		// Extract the path from the hint and verify the file
		// The hint wraps the path with a trailing period as sentence punctuation.
		const match = text.match(/written to (\S+\.json)/);
		expect(match).not.toBeNull();
		const spillPath = match![1]!;
		expect(existsSync(spillPath)).toBe(true);

		// File should contain valid JSON (the full response)
		const fileContent = readFileSync(spillPath, "utf-8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(fileContent);
		} catch {
			expect.fail("Spill file contains invalid JSON");
			return;
		}
		expect(Array.isArray((parsed as Record<string, unknown>).results)).toBe(true);
		expect(
			((parsed as Record<string, unknown>).results as unknown[]).length,
		).toBe(200);
		expect(fileContent.length).toBeGreaterThan(4000);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Write→verify→fix loop (end-to-end)
// ═══════════════════════════════════════════════════════════════════

describe("write→verify→fix loop", () => {
	it("writes a recipe, executes it, fixes it, re-executes", async () => {
		// ── 1. Write ─────────────────────────────────────────────
		const writeText = contentText(
			await callLearn("boe.es", boeRecipe(ctx.serverUrl)),
		);
		expect(writeText).toContain("Guide saved");
		invalidateCache();

		// ── 2. Verify ────────────────────────────────────────────
		const fetch1Text = contentText(
			await callFetch({
				domain: "boe.es",
				operation: "searchDiary",
				params: { date: "2026-07-17" },
			}),
		);
		expect(fetch1Text).toContain("Disposición");

		// ── 3. Fix — write a different recipe ───────────────────
		const fixedRecipe = boeRecipe(ctx.serverUrl).replace("icon: ⚖️", "icon: 🔧");
		const fixText = contentText(await callLearn("boe.es", fixedRecipe));
		expect(fixText).toContain("Guide saved");
		invalidateCache();

		// ── 4. Re-verify — guide detail reflects the fix ────────
		const detailText = contentText(await callGuide("boe.es"));
		expect(detailText).toContain("🔧");

		// api-fetch still works with the fixed guide
		const fetch2Text = contentText(
			await callFetch({
				domain: "boe.es",
				operation: "searchDiary",
				params: { date: "2026-07-18" },
			}),
		);
		expect(fetch2Text).toContain("2026-07-18");
	});

	it("catalog shows the guide after write", async () => {
		const text = contentText(await callGuide());
		expect(text).toContain("BOE");
	});
});

// ════════════════════════════════════════════════════════════════════
// Batch 2 — one domain, multiple API guides
// ════════════════════════════════════════════════════════════════════

/** api-guide with the optional `guide` (shortName) selector. */
function callGuideSelect(domain: string, guide: string) {
	return apiGuideTool.execute(
		"test",
		{ domain, guide },
		undefined,
		undefined,
		undefined as any,
	);
}

describe("api-guide — multi-guide disambiguation", () => {
	it("renders a disambiguation menu when multiple guides claim a domain", async () => {
		await callLearn("shared.example-rest", sharedRestRecipe(ctx.serverUrl));
		await callLearn("shared.example-action", sharedActionRecipe(ctx.serverUrl));
		invalidateCache();

		const result = await callGuide("shared.example");
		const text = contentText(result);
		expect(text).toContain("2 API guides for 'shared.example'");
		expect(text).toContain("(organization: shared.org)");
		// Each entry shows shortName + description + truncated op list.
		expect(text).toContain("SharedRest");
		expect(text).toContain("REST surface for the shared domain.");
		expect(text).toContain("SharedAction");
		expect(text).toContain("Action surface for the shared domain.");
		expect(text).toContain("2 ops: getDiary, restOnly");
		expect(text).toContain("2 ops: listConsolidada, actionOnly");
		// Footer points at the guide selector.
		expect(text).toContain('Call api-guide({domain: "shared.example", guide: "');
		expect(result.details).toMatchObject({
			domain: "shared.example",
			disambiguation: 2,
		});
	});

	it("selects a guide by shortName (exact, case-insensitive)", async () => {
		const result = await callGuideSelect(
			"shared.example",
			"sharedaction", // case-insensitive
		);
		const text = contentText(result);
		expect(text).toContain("SharedAction");
		expect(text).toContain("listConsolidada");
		expect(text).not.toContain("SharedRest");
		expect(result.details).toMatchObject({
			guide: "SharedAction",
			operations: 2,
		});
	});

	it("errors when the guide selector matches no shortName", async () => {
		const result = await callGuideSelect("shared.example", "Nope");
		const text = contentText(result);
		expect(text).toContain("No guide named 'Nope'");
		expect(text).toContain("Available guides:");
		expect(text).toContain("SharedRest");
		expect(text).toContain("SharedAction");
		expect(result.details).toMatchObject({
			error: "no_guide_by_shortname",
			guide: "Nope",
		});
	});

	it("errors when two same-domain guides share a shortName (b)", async () => {
		await callLearn(
			"collide.example-a",
			collideRecipe(ctx.serverUrl, "Collide", "opA"),
		);
		await callLearn(
			"collide.example-b",
			collideRecipe(ctx.serverUrl, "Collide", "opB"),
		);
		invalidateCache();

		const result = await callGuideSelect("collide.example", "Collide");
		const text = contentText(result);
		expect(text).toContain("Ambiguous guide 'Collide'");
		expect(text).toContain("2 guides share shortName 'Collide'");
		expect(text).toContain("directories: collide.example-a, collide.example-b");
		expect(result.details).toMatchObject({
			error: "ambiguous_shortname",
			directories: ["collide.example-a", "collide.example-b"],
		});
	});
});

describe("api-fetch — cross-guide op-name resolution", () => {
	it("resolves an op unique to one guide across a shared domain", async () => {
		// `getDiary` lives only in SharedRest; `listConsolidada` only in SharedAction.
		const restResult = await callFetch({
			domain: "shared.example",
			operation: "getDiary",
			params: { date: "2026-07-17" },
		});
		expect(contentText(restResult)).toContain("Disposición");
		expect(restResult!.details).toMatchObject({
			shortName: "SharedRest",
			operation: "getDiary",
		});

		const actionResult = await callFetch({
			domain: "shared.example",
			operation: "listConsolidada",
		});
		expect(contentText(actionResult)).toContain("fetched");
		expect(actionResult!.details).toMatchObject({
			shortName: "SharedAction",
			operation: "listConsolidada",
		});
	});

	it("lists ops from all matching guides on a zero-match (not just one)", async () => {
		const text = contentText(
			await callFetch({ domain: "shared.example", operation: "nope" }),
		);
		expect(text).toContain("No operation 'nope'");
		// Ops from both SharedRest and SharedAction appear.
		expect(text).toContain("getDiary");
		expect(text).toContain("restOnly");
		expect(text).toContain("listConsolidada");
		expect(text).toContain("actionOnly");
	});

	it("errors with a disambiguation menu when an op name collides across guides (a)", async () => {
		await callLearn(
			"opcollide.example-a",
			opCollideRecipe(ctx.serverUrl, "OpCollideA"),
		);
		await callLearn(
			"opcollide.example-b",
			opCollideRecipe(ctx.serverUrl, "OpCollideB"),
		);
		invalidateCache();

		const result = await callFetch({
			domain: "opcollide.example",
			operation: "fetchThing",
		});
		const text = contentText(result);
		expect(text).toContain("Ambiguous operation 'fetchThing'");
		expect(text).toContain("found in 2 guides");
		expect(text).toContain("OpCollideA");
		expect(text).toContain("OpCollideB");
		// Remediation points at api-guide then api-learn re-author; notes
		// api-learn rewrites a whole recipe; does NOT reference a guide: selector
		// on api-fetch.
		expect(text).toContain('api-guide({domain: "opcollide.example", guide:');
		expect(text).toContain("re-author one guide via api-learn");
		expect(text).toContain(
			"api-learn rewrites a whole recipe, not a single operation",
		);
		expect(text).not.toContain('api-fetch({domain: "opcollide.example", guide:');
		expect(result.details).toMatchObject({
			error: "ambiguous_operation",
			operation: "fetchThing",
		});
	});
});
