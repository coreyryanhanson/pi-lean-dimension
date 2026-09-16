/**
 * parseApiGuide() schema & parser tests.
 *
 * Covers:
 *  - BOE worked example parses to a valid ApiGuide with defaults filled.
 *  - Each malformed fixture returns a ParseError with dotted field path.
 *
 *  (projectToGuide/slug/loader/catalog/stampFrontmatterField tests live in
 *  guide-catalog.test.ts.)
 */

import { describe, it, expect } from "vitest";
import {
	parseApiGuide,
	PAGINATION_ALLOWLISTS,
	AUTH_ALLOWLISTS,
	PARAM_SPEC_KEYS,
	GUIDE_ALLOWLIST,
	OP_ALLOWLIST,
	RESPONSE_SHAPE_ALLOWLIST,
} from "../core/parse-api-guide.js";
import { parse as yamlParse } from "yaml";
import {
	GATHER_ALL_MAX_FALLBACK,
	type ApiGuide,
	type ParseError,
	type PaginationStyle,
} from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Worked example (the BOE API shape)
// ═══════════════════════════════════════════════════════════════════

const BOE_RECIPE = `---
schemaVersion: 1
kind: api
domains: [boe.es, www.boe.es]
icon: ⚖️
shortName: BOE
updated: 2026-07-17
apiHost: https://apidatos.boe.es/v1
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

pagination:
  style: offset-limit
  pageParam: page
  pageSizeParam: limit
  pageSize: 50
  itemsPath: data

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
    helper: true
    parse:
      format: xml
      charset: iso-8859-1

  - name: listConsolidada
    via: paginate
    path: /legislacion-consolidada
    accept: json
    pagination:
      style: cursor
      cursorParam: cursor
      cursorPath: pagination.nextCursor
      itemsPath: results
    gatherAllMax: 1000
---
# BOE Legislación Consolidada — structured API access

Use \`api-fetch\` with \`operation\` \`searchDiary\` to pull a day's dispatch.
`;

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function expectOk(
	raw: string,
	opts?: Parameters<typeof parseApiGuide>[1],
): ApiGuide {
	const res = parseApiGuide(raw, opts);
	if (!res.ok) {
		throw new Error(
			`expected ok, got error: ${res.error.field} — ${res.error.expected} (found: ${res.error.found})`,
		);
	}
	return res.guide;
}

function expectErr(
	raw: string,
	opts?: Parameters<typeof parseApiGuide>[1],
): ParseError {
	const res = parseApiGuide(raw, opts);
	if (res.ok) {
		throw new Error(`expected error, got ok guide for ${res.guide.shortName}`);
	}
	return res.error;
}

// Minimal valid recipe — reused across multiple describe blocks.
const MINIMAL = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
Prose body.
`;

// ═══════════════════════════════════════════════════════════════════
// Worked example — valid, defaults filled
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — BOE worked example", () => {
	it("parses to a valid ApiGuide with every field populated", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });

		expect(guide.kind).toBe("api");
		expect(guide.domains).toEqual(["boe.es", "www.boe.es"]);
		expect(guide.icon).toBe("⚖️");
		expect(guide.shortName).toBe("BOE");
		expect(guide.updated).toBe("2026-07-17");
		expect(guide.apiHost).toBe("https://apidatos.boe.es/v1");
		expect(guide.verified).toBe("2026-07-17");
		expect(guide.gatherAllMax).toBe(500);
		expect(guide.auth).toEqual({ kind: "none" });
		expect(guide.category).toBe("site");
		expect(guide.source).toBe("user");
		expect(guide.content).toContain("BOE Legislación Consolidada");
	});

	it("fills pagination top-level default", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });
		expect(guide.pagination?.style).toBe("offset-limit");
		expect(guide.pagination?.pageParam).toBe("page");
		expect(guide.pagination?.pageSizeParam).toBe("limit");
		expect(guide.pagination?.pageSize).toBe(50);
		expect(guide.pagination?.itemsPath).toBe("data");
	});

	it("fills responseShape default", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });
		expect(guide.responseShape).toEqual({ format: "json", charset: "utf-8" });
	});

	it("parses both operations with inferred path params", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });
		expect(guide.operations).toHaveLength(2);

		const search = guide.operations[0]!;
		expect(search.name).toBe("searchDiary");
		expect(search.via).toBe("restGet");
		expect(search.path).toBe("/diario/{date}");
		expect(search.accept).toBe("json");
		expect(search.pathParams).toEqual(["date"]);
		expect(search.params).toEqual({ limit: { default: 50 } });
		expect(search.helper).toBe(true);
		expect(search.parse).toEqual({ format: "xml", charset: "iso-8859-1" });

		const list = guide.operations[1]!;
		expect(list.name).toBe("listConsolidada");
		expect(list.via).toBe("paginate");
		expect(list.pathParams).toEqual([]);
		expect(list.pagination?.style).toBe("cursor");
		expect(list.pagination?.cursorParam).toBe("cursor");
		expect(list.pagination?.cursorPath).toBe("pagination.nextCursor");
		expect(list.pagination?.itemsPath).toBe("results");
		expect(list.gatherAllMax).toBe(1000);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Defaults-by-validator
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — defaults-by-validator", () => {
	it("defaults auth to none when omitted", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.auth).toEqual({ kind: "none" });
	});

	it("defaults verified to today when omitted", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		const today = new Date().toISOString().slice(0, 10);
		expect(guide.verified).toBe(today);
		expect(guide.updated).toBe(today);
	});

	it("defaults gatherAllMax to the global fallback when omitted", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.gatherAllMax).toBe(GATHER_ALL_MAX_FALLBACK);
	});

	it("defaults responseShape to json/utf-8 when omitted", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.responseShape).toEqual({ format: "json", charset: "utf-8" });
	});

	it("defaults accept to json when omitted", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.operations[0]!.accept).toBe("json");
	});

	it("defaults icon and shortName when omitted", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.icon).toBe("📖");
		expect(guide.shortName).toBe("example.com");
	});

	it("defaults kind to api", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.kind).toBe("api");
	});

	it("rejects kind: web in an api-guide (use a web-guide file instead)", () => {
		const raw = MINIMAL.replace(
			"domains: [example.com]",
			"kind: web\ndomains: [example.com]",
		);
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("kind");
		expect(err.found).toContain("web");
	});

	it("pagination not required when no op is via: paginate", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.pagination).toBeUndefined();
	});
});

// ═════════════════════════════════════════════════════════════
// cursor pagination — pageSizeParam/pageSize (optional, validated-if-present)
// ═════════════════════════════════════════════════════════════

describe("parseApiGuide — cursor page size", () => {
	// Minimal cursor paginate op; `pageSizeLines` swaps the page-size lines
	// (pageSizeParam/pageSize) per test, `cursorParamPath` overrides the
	// cursorParam value.
	function cursorRecipe(pageSizeLines: string, cursorParam = "after"): string {
		return `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: listThings
    via: paginate
    path: /things
    pagination:
      style: cursor
      cursorParam: ${cursorParam}
      cursorPath: pagination.nextCursor
${pageSizeLines}      itemsPath: data
---
Prose.
`;
	}

	it("cursor op declaring pageSizeParam + pageSize parses with both assigned", () => {
		const guide = expectOk(
			cursorRecipe("      pageSizeParam: first\n      pageSize: 20\n"),
			{
				filename: "example.com",
			},
		);
		const pag = guide.operations[0]!.pagination!;
		expect(pag.style).toBe("cursor");
		expect(pag.pageSizeParam).toBe("first");
		expect(pag.pageSize).toBe(20);
	});

	it("cursor op with pageSizeParam but no pageSize parses (Twitch post-deletion shape)", () => {
		const guide = expectOk(cursorRecipe("      pageSizeParam: first\n"), {
			filename: "example.com",
		});
		const pag = guide.operations[0]!.pagination!;
		expect(pag.pageSizeParam).toBe("first");
		expect(pag.pageSize).toBeUndefined();
	});

	it("cursor op with neither pageSizeParam nor pageSize parses (internet-archive shape)", () => {
		const guide = expectOk(cursorRecipe("", "cursor"), {
			filename: "example.com",
		});
		const pag = guide.operations[0]!.pagination!;
		expect(pag.pageSizeParam).toBeUndefined();
		expect(pag.pageSize).toBeUndefined();
	});

	it("cursor op with a type-invalid pageSize now fails to parse", () => {
		const err = expectErr(
			cursorRecipe('      pageSizeParam: first\n      pageSize: "20"\n'),
			{
				filename: "example.com",
			},
		);
		expect(err.field).toMatch(/pagination\.pageSize$/);
	});

	it("cursor op with pageSize but no pageSizeParam fails (inert half-pair)", () => {
		const err = expectErr(cursorRecipe("      pageSize: 20\n"), {
			filename: "example.com",
		});
		expect(err.field).toMatch(/pagination\.pageSize$/);
		expect(err.expected).toContain("pageSizeParam");
	});

	it("cursor op with an empty-string pageSizeParam fails to parse", () => {
		const err = expectErr(cursorRecipe('      pageSizeParam: ""\n'), {
			filename: "example.com",
		});
		expect(err.field).toMatch(/pagination\.pageSizeParam$/);
	});
});

// ═══════════════════════════════════════════════════════════════════
// docs — optional API documentation URL
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — docs field", () => {
	it("accepts an http/https docs URL", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
docs: https://www.example.com/docs/api
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const guide = expectOk(raw, { filename: "example.com" });
		expect(guide.docs).toBe("https://www.example.com/docs/api");
	});

	it("omits docs when the field is absent", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.docs).toBeUndefined();
	});

	it("rejects a non-string docs value", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
docs: 123
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("docs");
	});

	it("rejects a non-http(s) docs URL", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
docs: ftp://example.com/docs
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("docs");
		expect(err.found).toBe('protocol "ftp:"');
	});
});

// ═══════════════════════════════════════════════════════════════════
// organization / description fields (recipe-slice, not projected)
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — organization & description", () => {
	it("accepts organization and description", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
organization: example.org
description: One-line API summary.
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const guide = expectOk(raw, { filename: "example.com" });
		expect(guide.organization).toBe("example.org");
		expect(guide.description).toBe("One-line API summary.");
	});

	it("omits organization and description when absent", () => {
		const guide = expectOk(MINIMAL, { filename: "example.com" });
		expect(guide.organization).toBeUndefined();
		expect(guide.description).toBeUndefined();
	});

	it("rejects a non-string organization", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
organization: 123
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("organization");
	});

	it("rejects an empty organization", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
organization: ""
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("organization");
	});

	it("rejects a non-string description", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
description: 123
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("description");
	});

	it("rejects a description containing a newline (structural)", () => {
		// One parser, two call sites: newline rejection is structural (is it
		// one line?), enforced by the parser on both load and write paths. A
		// double-quoted YAML scalar with a \n escape yields a real newline in
		// the parsed value, which the parser rejects.
		const raw = `---
schemaVersion: 1
domains: [example.com]
description: "first line\\nsecond line"
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("description");
		expect(err.found).toContain("newline");
		expect(err.fix).toBeDefined();
	});

	it("does NOT enforce the description length cap (lenient-on-read)", () => {
		// The ≤200-char cap is an api-learn write-path policy, not a parser
		// concern — a hand-edited longer description loads fine.
		const long = "x".repeat(300);
		const raw = `---
schemaVersion: 1
domains: [example.com]
description: ${long}
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
---
`;
		const guide = expectOk(raw, { filename: "example.com" });
		expect(guide.description).toBe(long);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Malformed fixtures
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — malformed recipes", () => {
	it("missing leading / in path → ParseError on operations[N].path", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: things/{id}
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].path");
		expect(err.expected).toContain("beginning with /");
		expect(err.found).toContain("missing leading /");
		expect(err.fix).toBeDefined();
	});

	it("unknown via → ParseError on operations[N].via", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restPost
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].via");
		expect(err.expected).toContain("restGet | paginate");
		expect(err.found).toBe("restPost");
	});

	it("unknown auth.kind → ParseError on auth.kind", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
auth:
  kind: basic
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("auth.kind");
		expect(err.expected).toContain("none | static-key | oauth2");
		expect(err.found).toBe("basic");
	});

	it("missing auth.kind → ParseError with fix naming none | static-key", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
auth:
  secretRefs:
    Authorization: apiKey
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("auth.kind");
		expect(err.found).toBe("missing");
		expect(err.fix).toContain("none | static-key");
		expect(err.fix).toContain("kind: static-key");
		expect(err.fix).toContain("new: true");
	});

	it("unknown auth key (name/secret wrong shape) → expected lists the known keys", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
auth:
  kind: static-key
  name: X-EXAMPLE_PRO_API_KEY
  secret: api_key
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("auth.name");
		expect(err.found).toBe("unknown key(s): name, secret");
		expect(err.expected).toContain("secretRefs");
		expect(err.expected).toContain("secretQueryRefs");
	});

	it("unknown auth key (requiers:) → expected lists the known keys", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
auth:
  kind: static-key
  secretRefs:
    x-api-key: api_key
  requiers:
    - api_key
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("auth.requiers");
		expect(err.expected).toContain("kind, headers, secretRefs, secretQueryRefs");
	});

	it("paginate op with no pagination → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination");
		expect(err.expected).toContain("required when via: paginate");
	});

	it("paginate op rescued by top-level pagination", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
pagination:
  style: offset-limit
  pageParam: page
  pageSizeParam: limit
  pageSize: 20
  itemsPath: data
operations:
  - name: list
    via: paginate
    path: /things
---
body
`;
		const guide = expectOk(raw);
		expect(guide.operations[0]!.via).toBe("paginate");
		expect(guide.pagination?.style).toBe("offset-limit");
	});

	it("missing apiHost → ParseError on apiHost", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("apiHost");
	});

	it("missing domains → ParseError on domains", () => {
		const raw = `---
schemaVersion: 1
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("domains");
		expect(err.fix).toContain("new: true");
	});

	it("missing operations → ParseError on operations", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations");
	});

	it("empty operations array → ParseError on operations", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations: []
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations");
		expect(err.found).toBe("an array");
	});

	it("path param with required/default in params → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /things/{id}
    params:
      id:
        required: true
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].params.id");
		expect(err.expected).toContain("inferred from {token}");
		// The rejection message offers the docs-only alternative now.
		expect(err.fix).toContain("params.id.description");
	});

	it("accepts a docs-only description on a path param token", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /things/{id}
    params:
      id:
        description: UUID of the thing.
---
body
`;
		const guide = expectOk(raw);
		const op = guide.operations[0]!;
		// Docs stored separately — the token is NOT a query param.
		expect(op.pathParamDocs).toEqual({ id: "UUID of the thing." });
		expect(op.params["id"]).toBeUndefined();
		expect(op.pathParams).toEqual(["id"]);
	});

	it("accepts multiple path-param descriptions alongside query params", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /packs/{pack_code}/cards/{card_code}
    params:
      pack_code:
        description: "The pack code, e.g. 'Core'."
      card_code:
        description: "The card's code, e.g. '01001'."
      q:
        description: Search term.
---
body
`;
		const guide = expectOk(raw);
		const op = guide.operations[0]!;
		expect(op.pathParamDocs).toEqual({
			pack_code: "The pack code, e.g. 'Core'.",
			card_code: "The card's code, e.g. '01001'.",
		});
		expect(op.params["q"]?.description).toBe("Search term.");
		expect(op.params["pack_code"]).toBeUndefined();
	});

	it("rejects a non-string path-param description", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /things/{id}
    params:
      id:
        description: 123
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].params.id.description");
		expect(err.expected).toContain("a string");
	});

	it("rejects a path param token carrying a non-description key", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /things/{id}
    params:
      id:
        default: 1
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].params.id");
		expect(err.expected).toContain("docs-only");
	});

	it("rejects a bare path param token (null spec)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /things/{id}
    params:
      id:
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].params.id");
		expect(err.expected).toContain("docs-only");
		expect(err.found).toContain("null");
	});

	it("rejects an explicitly empty path-param mapping", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: get
    via: restGet
    path: /things/{id}
    params:
      id: {}
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].params.id");
		expect(err.expected).toContain("docs-only");
		expect(err.found).toContain("empty");
	});

	it("captures param description hints", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: restGet
    path: /items
    params:
      q:
        required: true
        description: Full-text search term.
      fecha:
        description: Date in YYYYMMDD form (a full day).
---
body
`;
		const guide = expectOk(raw);
		const op = guide.operations[0]!;
		expect(op.params["q"]?.description).toBe("Full-text search term.");
		expect(op.params["q"]?.required).toBe(true);
		expect(op.params["fecha"]?.description).toBe(
			"Date in YYYYMMDD form (a full day).",
		);
	});

	it("rejects a non-string param description", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: restGet
    path: /items
    params:
      q:
        description: 123
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].params.q.description");
		expect(err.expected).toContain("a string");
	});

	it("accepts passthrough: true on an operation", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: query
    via: restGet
    path: /query.json
    accept: json
    passthrough: true
    params:
      type:
        required: true
---
body
`;
		const guide = expectOk(raw);
		const op = guide.operations[0]!;
		expect(op.passthrough).toBe(true);
	});

	it("rejects a non-boolean passthrough", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: query
    via: restGet
    path: /query.json
    passthrough: "yes"
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].passthrough");
		expect(err.expected).toContain("true or omitted");
	});

	it("accepts transform: true on an operation", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: queryCdx
    via: restGet
    path: /cdx
    transform: true
---
body
`;
		const guide = expectOk(raw);
		expect(guide.operations[0]!.transform).toBe(true);
	});

	it("rejects a non-boolean transform (string)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://example.com
operations:
  - name: queryCdx
    via: restGet
    path: /cdx
    transform: "yes"
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].transform");
		expect(err.expected).toContain("boolean");
	});

	it("rejects a non-boolean transform (number)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://example.com
operations:
  - name: queryCdx
    via: restGet
    path: /cdx
    transform: 1
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].transform");
		expect(err.expected).toContain("boolean");
	});

	it("omitting transform leaves it undefined", () => {
		const guide = expectOk(MINIMAL);
		expect(guide.operations[0]!.transform).toBeUndefined();
	});

	describe("parseApiGuide — requiresAnyOf", () => {
		it("parses requiresAnyOf on an operation", () => {
			const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: getResource
    via: restGet
    path: /resources
    requiresAnyOf: [id, slug, code]
    params:
      id:
        description: Resource id.
      slug:
        description: Resource slug.
      code:
        description: Resource code.
---
body
`;
			const guide = expectOk(raw);
			const op = guide.operations[0]!;
			expect(op.requiresAnyOf).toEqual(["id", "slug", "code"]);
		});

		it("omits requiresAnyOf when absent", () => {
			const guide = expectOk(MINIMAL);
			expect(guide.operations[0]!.requiresAnyOf).toBeUndefined();
		});

		it("rejects an empty requiresAnyOf array", () => {
			const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: getResource
    via: restGet
    path: /resources
    requiresAnyOf: []
    params:
      id:
        description: Resource id.
---
body
`;
			const err = expectErr(raw);
			expect(err.field).toBe("operations[0].requiresAnyOf");
			expect(err.expected).toContain("non-empty list");
		});

		it("rejects a requiresAnyOf member that is not a declared param", () => {
			const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: getResource
    via: restGet
    path: /resources
    requiresAnyOf: [id, code]
    params:
      id:
        description: Resource id.
---
body
`;
			const err = expectErr(raw);
			expect(err.field).toBe("operations[0].requiresAnyOf.code");
			expect(err.expected).toContain("declared in this operation's params");
		});

		it("rejects a requiresAnyOf member that is a path param", () => {
			const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: getThing
    via: restGet
    path: /things/{id}
    requiresAnyOf: [id, code]
    params:
      code:
        description: Resource code.
---
body
`;
			const err = expectErr(raw);
			expect(err.field).toBe("operations[0].requiresAnyOf.id");
			expect(err.expected).toContain("not a path param");
		});

		it("rejects a requiresAnyOf member that is required: true", () => {
			const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: getResource
    via: restGet
    path: /resources
    requiresAnyOf: [id, code]
    params:
      id:
        required: true
      code:
        description: Resource code.
---
body
`;
			const err = expectErr(raw);
			expect(err.field).toBe("operations[0].requiresAnyOf.id");
			expect(err.expected).toContain("not also required");
			expect(err.fix).toContain("Remove required: true");
		});

		it("rejects a requiresAnyOf member that carries a default (at-least-one-of peers)", () => {
			const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: getResource
    via: restGet
    path: /resources
    requiresAnyOf: [id, code]
    params:
      id:
        default: 1027
      code:
        description: Resource code.
---
body
`;
			const err = expectErr(raw);
			expect(err.field).toBe("operations[0].requiresAnyOf.id");
			expect(err.expected).toContain("not also declare a default");
			expect(err.fix).toContain("Remove the default from params.id");
			expect(err.fix).toContain("at-least-one-of peers");
		});
	});

	it("no frontmatter → ParseError on frontmatter", () => {
		const err = expectErr("just prose, no frontmatter");
		expect(err.field).toBe("frontmatter");
	});

	// The opener-present cases route to a closing-`---` diagnostic
	// instead of the misleading "no frontmatter found".
	it("opening --- with no closing --- → names the missing closer", () => {
		const err = expectErr(
			`---\ndomains: [example.com]\napiHost: https://api.example.com`,
		);
		expect(err.field).toBe("frontmatter");
		expect(err.found).toBe("missing closing ---");
		expect(err.found).not.toContain("no frontmatter");
		expect(err.fix).toContain("---");
	});

	it("opening --- with a malformed closer (no trailing newline) → diagnosed", () => {
		// FRONTMATTER_RE needs a newline after the closing ---; a closer at EOF
		// without one is present-but-malformed, not missing.
		const err = expectErr(
			`---\ndomains: [example.com]\napiHost: https://api.example.com\n---`,
		);
		expect(err.field).toBe("frontmatter");
		expect(err.found).toContain("closing --- present but malformed");
		expect(err.fix).toContain("newline");
	});

	it("CRLF opening --- with no closing --- → names the missing closer", () => {
		const err = expectErr(
			`---\r\ndomains: [example.com]\r\napiHost: https://api.example.com`,
		);
		expect(err.field).toBe("frontmatter");
		expect(err.found).toBe("missing closing ---");
	});

	it("CRLF opening --- with a malformed closer → diagnosed", () => {
		const err = expectErr(
			`---\r\ndomains: [example.com]\r\napiHost: https://api.example.com\r\n---`,
		);
		expect(err.field).toBe("frontmatter");
		expect(err.found).toContain("closing --- present but malformed");
	});

	it("no opening --- at all → existing 'no frontmatter found' preserved", () => {
		// Starts with prose, not ---; a stray --- later in the body is not an
		// opening delimiter, so the common no-frontmatter diagnostic stays.
		const err = expectErr("prose\n---\nmore prose");
		expect(err.field).toBe("frontmatter");
		expect(err.found).toBe("no frontmatter found");
	});

	it("invalid YAML → ParseError on frontmatter", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com
  bad: yaml: :
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("frontmatter");
		expect(err.expected).toContain("valid YAML");
	});

	it("multiple backtick-leading plain scalars → all offending lines in one pass", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things
    params:
      id:
        description: \`the id\`
      sort:
        description: \`sort order\`
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("frontmatter");
		expect(err.expected).toContain("valid YAML");
		// Both offenders reported in the same error — not one per run.
		// Line numbers are relative to the frontmatter block (the opening
		// `---` is not part of `fm`), matching yamlParse's own reporting.
		expect(err.found).toContain("line 10, column 22: `");
		expect(err.found).toContain("line 12, column 22: `");
		expect(err.fix).toContain("Quote the value");
	});

	it("backtick mid-value (not at start) → parses fine, no pre-scan hit", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things
    params:
      id:
        description: the \`id\` field
---
body
`;
		const res = parseApiGuide(raw, { filename: "example.com" });
		expect(res.ok).toBe(true);
	});

	it("backticks inside a folded block scalar (description: >) → not flagged", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things
    params:
      id:
        description: >
          Field prefixes: \`all:\` \`ti:\` \`au:\`; one date filter
          \`submittedDate:[YYYYMMDDTTTT+TO+YYYYMMDDTTTT]\` (GMT).
---
body
`;
		const res = parseApiGuide(raw, { filename: "example.com" });
		expect(res.ok).toBe(true);
	});

	it("quoted backtick value → not flagged (valid YAML)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThing
    via: restGet
    path: /things
    params:
      id:
        description: "the \`id\` field"
---
body
`;
		const res = parseApiGuide(raw, { filename: "example.com" });
		expect(res.ok).toBe(true);
	});

	it("apiHost without scheme → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: api.example.com/v1
operations:
  - name: get
    via: restGet
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("apiHost");
		expect(err.found).toContain("api.example.com/v1");
	});

	it("unknown pagination style → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
pagination:
  style: infinite
  itemsPath: data
operations:
  - name: list
    via: paginate
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("pagination.style");
	});

	it("offset-limit missing pageParam → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
pagination:
  style: offset-limit
  pageSizeParam: limit
  itemsPath: data
operations:
  - name: list
    via: paginate
    path: /things
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("pagination.pageParam");
	});

	it("valid resumptionToken config parses", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /records
    pagination:
      style: resumptionToken
      tokenParam: resumptionToken
      tokenPath: ListRecords.resumptionToken
      itemsPath: ListRecords.record
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.style).toBe("resumptionToken");
		expect(p.tokenParam).toBe("resumptionToken");
		expect(p.tokenPath).toBe("ListRecords.resumptionToken");
	});

	// B1 — totalCountPath parses for any pagination style (not just
	// resumptionToken); absent → field is simply not set.
	it("parses totalCountPath for an offset-limit pagination (any style)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      itemsPath: results
      totalCountPath: total_count
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.totalCountPath).toBe("total_count");
	});

	it("parses totalCountPath without setting it when absent", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      itemsPath: results
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.totalCountPath).toBeUndefined();
	});

	// #5 — `base` seeds the page param for the seeding styles; accepted and
	// projected when present, absent stays undefined, non-finite rejected.
	it("parses base for an offset-limit pagination", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: start
      pageSizeParam: limit
      itemsPath: results
      base: 1
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.base).toBe(1);
	});

	it("leaves base undefined when absent", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: start
      pageSizeParam: limit
      itemsPath: results
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.base).toBeUndefined();
	});

	it("rejects a non-integer base", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: start
      pageSizeParam: limit
      itemsPath: results
      base: 1.5
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination.base");
	});

	it("rejects an empty totalCountPath", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      itemsPath: results
      totalCountPath: ""
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination.totalCountPath");
	});

	// B2 — hasMorePath mirrors totalCountPath: parses for any style, absent
	// stays unset, empty rejected.
	it("parses hasMorePath for an offset-limit pagination (any style)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      itemsPath: results
      hasMorePath: has_more
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.hasMorePath).toBe("has_more");
	});

	it("parses hasMorePath without setting it when absent", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      itemsPath: results
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.hasMorePath).toBeUndefined();
	});

	it("rejects an empty hasMorePath", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /search
    pagination:
      style: offset-limit
      pageParam: offset
      pageSizeParam: limit
      itemsPath: results
      hasMorePath: ""
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination.hasMorePath");
	});

	it("resumptionToken missing tokenParam → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /records
    pagination:
      style: resumptionToken
      tokenPath: ListRecords.resumptionToken
      itemsPath: ListRecords.record
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination.tokenParam");
	});

	it("resumptionToken missing tokenPath → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /records
    pagination:
      style: resumptionToken
      tokenParam: resumptionToken
      itemsPath: ListRecords.record
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination.tokenPath");
	});

	it("valid tokenBag config parses", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /changes
    pagination:
      style: tokenBag
      continuationParams:
        - continue.continue
        - continue.rccontinue
      itemsPath: query.recentchanges
---
body
`;
		const guide = expectOk(raw);
		const p = guide.operations[0]!.pagination!;
		expect(p.style).toBe("tokenBag");
		expect(p.continuationParams).toEqual([
			"continue.continue",
			"continue.rccontinue",
		]);
	});

	it("tokenBag missing continuationParams → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /changes
    pagination:
      style: tokenBag
      itemsPath: query.recentchanges
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination.continuationParams");
	});

	it("tokenBag with empty continuationParams → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
operations:
  - name: list
    via: paginate
    path: /changes
    pagination:
      style: tokenBag
      continuationParams: []
      itemsPath: query.recentchanges
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].pagination.continuationParams");
	});

	it("file path threaded into ParseError", () => {
		const err = expectErr("no frontmatter", {
			file: "/tmp/guides/broken.md",
		});
		expect(err.file).toBe("/tmp/guides/broken.md");
	});
});

// ═════════════════════════════════════════════════════════════════
// pagination key allowlist — unknown keys fail at parse, not silently
// ═════════════════════════════════════════════════════════════════

describe("parseApiGuide — pagination key allowlist", () => {
	// The expected key set per style: exactly what validatePagination() reads.
	// One table shared by three checks — the tripwire asserts PAGINATION_ALLOWLISTS
	// equals it (drift in either direction fails), and the round-trip grounds it
	// in parser behavior (an allowlisted key the parser never reads would fail
	// here instead of silently no-oping).
	const EXPECTED_KEYS: Record<PaginationStyle, readonly string[]> = {
		"offset-limit": [
			"style",
			"itemsPath",
			"pageParam",
			"pageSizeParam",
			"pageSize",
			"base",
			"totalCountPath",
			"hasMorePath",
		],
		page: [
			"style",
			"itemsPath",
			"pageParam",
			"pageSizeParam",
			"pageSize",
			"base",
			"totalCountPath",
			"hasMorePath",
		],
		nextLink: [
			"style",
			"itemsPath",
			"nextLinkPath",
			"totalCountPath",
			"hasMorePath",
		],
		cursor: [
			"style",
			"itemsPath",
			"cursorParam",
			"cursorPath",
			"pageSizeParam",
			"pageSize",
			"totalCountPath",
			"hasMorePath",
		],
		resumptionToken: [
			"style",
			"itemsPath",
			"tokenParam",
			"tokenPath",
			"totalCountPath",
			"hasMorePath",
		],
		tokenBag: [
			"style",
			"itemsPath",
			"continuationParams",
			"totalCountPath",
			"hasMorePath",
		],
	};
	const STYLES = Object.keys(EXPECTED_KEYS) as PaginationStyle[];

	// Sample YAML value + parsed expectation per non-style allowlisted key.
	const KEY_VALUES: Record<string, { yaml: string; parsed: unknown }> = {
		itemsPath: { yaml: "data", parsed: "data" },
		pageParam: { yaml: "offset", parsed: "offset" },
		pageSizeParam: { yaml: "limit", parsed: "limit" },
		pageSize: { yaml: "25", parsed: 25 },
		base: { yaml: "1", parsed: 1 },
		nextLinkPath: { yaml: "links.next", parsed: "links.next" },
		cursorParam: { yaml: "cursor", parsed: "cursor" },
		cursorPath: { yaml: "meta.next", parsed: "meta.next" },
		tokenParam: { yaml: "resumptionToken", parsed: "resumptionToken" },
		tokenPath: {
			yaml: "ListRecords.resumptionToken",
			parsed: "ListRecords.resumptionToken",
		},
		continuationParams: { yaml: "[a, b]", parsed: ["a", "b"] },
		totalCountPath: { yaml: "total", parsed: "total" },
		hasMorePath: { yaml: "has_more", parsed: "has_more" },
	};

	function paginationYaml(style: PaginationStyle, indent: string): string {
		return EXPECTED_KEYS[style]
			.map((k) =>
				k === "style"
					? `${indent}style: ${style}`
					: `${indent}${k}: ${KEY_VALUES[k]!.yaml}`,
			)
			.join("\n");
	}

	function guideWithPagination(paginationBlock: string): string {
		return `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
${paginationBlock}
operations:
  - name: list
    via: paginate
    path: /things
---
body
`;
	}

	// Tripwire (both directions): the allowlist must EQUAL the keys the parser
	// reads. The reverse direction is load-bearing — an allowlisted key the
	// parser never assigns re-creates the silent-drop bug this allowlist kills.
	it("allowlists exactly match the keys validatePagination() reads, per style", () => {
		for (const style of STYLES) {
			expect([...PAGINATION_ALLOWLISTS[style]].sort(), style).toEqual(
				[...EXPECTED_KEYS[style]].sort(),
			);
		}
	});

	// Round-trip: a guide carrying every expected key for a style parses and
	// preserves every key on the resulting PaginationConfig. Also proves
	// totalCountPath is accepted on every style (it is in every config here).
	it("round-trip: every allowlisted key parses and is preserved", () => {
		for (const style of STYLES) {
			const guide = expectOk(
				guideWithPagination(`pagination:\n${paginationYaml(style, "  ")}`),
			);
			const expected: Record<string, unknown> = {};
			for (const k of EXPECTED_KEYS[style]) {
				expected[k] = k === "style" ? style : KEY_VALUES[k]!.parsed;
			}
			expect(guide.pagination, style).toEqual(expected);
		}
	});

	it("rejects one wrong-style key per style, listing the style's valid keys", () => {
		// Each stray is a real key from a DIFFERENT style — the cross-style
		// confusion the allowlist exists to catch.
		const stray: Record<PaginationStyle, string> = {
			"offset-limit": "nextLinkPath",
			page: "nextLinkPath",
			nextLink: "cursorPath",
			cursor: "nextLinkPath",
			resumptionToken: "continuationParams",
			tokenBag: "tokenParam",
		};
		for (const style of STYLES) {
			const err = expectErr(
				guideWithPagination(
					`pagination:\n${paginationYaml(style, "  ")}\n  ${stray[style]}: stray`,
				),
			);
			expect(err.field, style).toBe(`pagination.${stray[style]}`);
			expect(err.expected, style).toContain(
				`a known pagination key for style: ${style}`,
			);
			for (const k of EXPECTED_KEYS[style]) {
				expect(err.expected, style).toContain(k);
			}
		}
	});

	it("realistic trigger: itemsPath misspelled as itemPath → error names itemPath and lists valid fields", () => {
		const err = expectErr(
			guideWithPagination(
				`pagination:\n  style: offset-limit\n  itemPath: data\n  pageParam: page\n  pageSizeParam: limit`,
			),
		);
		expect(err.field).toBe("pagination.itemPath");
		expect(err.expected).toContain("itemsPath");
	});

	it("multiple unknown keys are listed together in one error", () => {
		const err = expectErr(
			guideWithPagination(
				`pagination:\n  style: offset-limit\n  itemPath: data\n  bogusOne: 1\n  pageParam: page\n  pageSizeParam: limit`,
			),
		);
		expect(err.field).toBe("pagination.itemPath");
		expect(err.found).toBe("unknown key(s): itemPath, bogusOne");
	});
});

// ═══════════════════════════════════════════════════════════════════
// dateParams — valid and invalid
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — dateParams", () => {
	it("parses valid dateParams on an operation", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThings
    via: restGet
    path: /things
    dateParams:
      since: iso8601
      until: iso8601
      fecha: yyyymmdd
---
body
`;
		const guide = expectOk(raw);
		const op = guide.operations[0]!;
		expect(op.dateParams).toEqual({
			since: "iso8601",
			until: "iso8601",
			fecha: "yyyymmdd",
		});
	});

	it("rejects an invalid date format string", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThings
    via: restGet
    path: /things
    dateParams:
      since: rfc2822
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].dateParams.since");
		expect(err.expected).toContain("iso8601 | yyyymmdd | yyyy-mm-dd");
	});

	it("rejects dateParams when the value is not a mapping", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThings
    via: restGet
    path: /things
    dateParams: true
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].dateParams");
		expect(err.expected).toContain("YAML mapping");
	});

	it("rejects listStyle on a param also named in dateParams (mutually exclusive)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThings
    via: restGet
    path: /things
    params:
      since:
        listStyle: comma
    dateParams:
      since: iso8601
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].dateParams.since");
		expect(err.expected).toContain("listStyle can never apply");
	});

	it("rejects dateParams naming a path token (declared-but-dead)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getAggregate
    via: restGet
    path: /aggs/{ticker}/range/{from}/{to}
    dateParams:
      from: iso8601
---
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("operations[0].dateParams.from");
		expect(err.found).toContain("path param");
		expect(err.found).toContain("can never fire");
		// Real pattern + additive-future pointer, per the dead-declaration class.
		expect(err.fix).toContain("Polygon.io");
		expect(err.fix).toContain("Frankfurter");
		expect(err.fix).toContain("additive");
	});

	it("accepts operation without dateParams", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
operations:
  - name: getThings
    via: restGet
    path: /things
---
body
`;
		const guide = expectOk(raw);
		expect(guide.operations[0]!.dateParams).toBeUndefined();
	});
});

// ═════════════════════════════════════════════════════════════════
// errorPath — present-only-on-error envelope path
// ═════════════════════════════════════════════════════════════════

describe("parseApiGuide — errorPath", () => {
	const base = (opBody: string, guideExtras = "") => `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
${guideExtras}
operations:
  - name: getThings
    via: restGet
    path: /things
${opBody}
---
body
`;

	it("parses a valid errorPath onto the operation", () => {
		const guide = expectOk(base("    errorPath: result.error"));
		expect(guide.operations[0]!.errorPath).toBe("result.error");
	});

	it("accepts a quoted-bracket tokenizeable path", () => {
		const guide = expectOk(base("    errorPath: result['error.message']"));
		expect(guide.operations[0]!.errorPath).toBe("result['error.message']");
	});

	it("rejects a non-string errorPath", () => {
		const err = expectErr(base("    errorPath: true"));
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("non-empty string JSON path");
	});

	it("rejects an empty errorPath", () => {
		const err = expectErr(base('    errorPath: ""'));
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("non-empty string JSON path");
	});

	it("rejects a non-tokenizeable errorPath (malformed bracket)", () => {
		// A malformed path would resolve `undefined` at runtime — declared-absent
		// → success: the confidently-wrong failure mode this field exists to kill.
		const err = expectErr(base('    errorPath: "results[-]"'));
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("tokenizeable JSON path");
	});

	it("rejects an unterminated quoted bracket", () => {
		const err = expectErr(base('    errorPath: "[\'oops]"'));
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("tokenizeable JSON path");
	});

	it("rejects the root path ($) — empty tokenization", () => {
		// The root resolves the entire parsed body — always defined post-parse,
		// so every call would fail.
		const err = expectErr(base('    errorPath: "$"'));
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("document root");
	});

	it("rejects the bare-dot path (.) — empty tokenization", () => {
		const err = expectErr(base('    errorPath: "."'));
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("document root");
	});

	it("rejects errorPath on an op with a text parse override", () => {
		// parseResponse yields the raw body string for text ops — resolveJsonPath
		// against a string always resolves undefined, so the check could never
		// fire (declared-then-dead config indistinguishable from working config).
		const err = expectErr(
			base("    errorPath: error\n    parse:\n      format: text"),
		);
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("format: text");
	});

	it("rejects errorPath on an op inheriting a text guide-level responseShape", () => {
		// Same dead-config class via inheritance — the effective shape is
		// parse ?? guide.responseShape, so the guard covers both.
		const err = expectErr(
			base("    errorPath: error", "responseShape:\n  format: text\n"),
		);
		expect(err.field).toBe("operations[0].errorPath");
		expect(err.expected).toContain("format: text");
	});

	it("accepts errorPath with an xml parse override (xml resolves a shape)", () => {
		const guide = expectOk(
			base("    errorPath: error\n    parse:\n      format: xml"),
		);
		expect(guide.operations[0]!.errorPath).toBe("error");
	});

	it("accepts errorPath on an op without parse under a json guide responseShape", () => {
		const ok = expectOk(
			base("    errorPath: error", "responseShape:\n  format: json\n"),
		);
		expect(ok.operations[0]!.errorPath).toBe("error");
	});
});

// ═══════════════════════════════════════════════════════════════════
// secretPathRefs — token-in-path secret injection
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — auth field allowlist tripwire", () => {
	// Two-direction tripwire, per auth kind: the allowlist must EQUAL the keys
	// the validator reads. The reverse direction is load-bearing — an
	// allowlisted key the parser never assigns re-creates the silent-drop bug
	// this allowlist kills (same pattern as the pagination allowlist tripwire).
	it("allowlists exactly match the keys each auth validator reads", () => {
		expect([...AUTH_ALLOWLISTS["none"]].sort()).toEqual(
			["headers", "kind"].sort(),
		);
		expect([...AUTH_ALLOWLISTS["static-key"]].sort()).toEqual(
			[
				"headers",
				"kind",
				"secretPathRefs",
				"secretQueryRefs",
				"secretRefs",
			].sort(),
		);
		expect([...AUTH_ALLOWLISTS["oauth2"]].sort()).toEqual(
			[
				"authorizeUrl",
				"clientId",
				"clientSecret",
				"grant",
				"kind",
				"paramStyle",
				"revokeUrl",
				"scopes",
				"secretRefs",
				"tokenEndpointAuthMethod",
				"tokenUrl",
			].sort(),
		);
	});
});

describe("parseApiGuide — param-spec key allowlist tripwire", () => {
	// Two-direction tripwire: the allowlist must EQUAL the keys the param-spec
	// reader assigns. The reverse direction is load-bearing — an allowlisted
	// key with no s["<key>"] handling block is accepted then silently dropped,
	// re-creating the silent-no-op bug this allowlist kills (same pattern as
	// the pagination/auth allowlist tripwires).
	it("allowlist exactly matches the keys the param-spec reader assigns", () => {
		expect([...PARAM_SPEC_KEYS].sort()).toEqual(
			["default", "description", "listStyle", "required"].sort(),
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Allowlist round-trip fixture — one guide carrying EVERY allowlisted key
// on every authored surface (frontmatter, op block, responseShape at both
// levels). The tripwire tests parse the same frontmatter two ways: raw
// YAML (to assert its key sets EQUAL the allowlists) and through
// parseApiGuide (to assert every key is accepted and lands on the parsed
// result). Drift fails loudly in every direction: adding an allowlist key
// without a fixture value fails the coverage assertion, dropping one
// fails the fixture's own parse (unknown key), and a key the parser stops
// reading fails the landed assertions. Note: `pathParamDocs` is
// deliberately absent — it's a parser-derived OUTPUT field built from
// params.<token>.description, never an authored op-block key.
// ═══════════════════════════════════════════════════════════════════

const ROUNDTRIP_FM = `kind: api
domains: [roundtrip.example]
shortName: RoundTrip
updated: 2026-01-02
icon: 🧪
apiHost: https://api.roundtrip.example/v1
verified: 2026-01-02
docs: https://docs.roundtrip.example
organization: RoundTrip Org
description: one guide carrying every allowlisted key
schemaVersion: 1
gatherAllMax: 42
auth:
  kind: none
responseShape:
  format: xml
  charset: iso-8859-1
pagination:
  style: page
  itemsPath: rows
  pageParam: p
  pageSizeParam: perPage
operations:
  - name: getAll
    via: paginate
    path: /things
    accept: json
    params:
      from:
        description: start date
      kind:
        description: filter
    requiresAnyOf: [kind]
    dateParams:
      from: iso8601
    helper: true
    transform: true
    passthrough: true
    parse:
      format: json
      charset: utf-8
    errorPath: error
    pagination:
      style: offset-limit
      itemsPath: results
      pageParam: page
      pageSizeParam: perPage
    gatherAllMax: 7
`;

function roundtripGuide(): ApiGuide {
	return expectOk(`---\n${ROUNDTRIP_FM}---\nbody`);
}
function roundtripFm(): Record<string, unknown> {
	return yamlParse(ROUNDTRIP_FM) as Record<string, unknown>;
}

describe("parseApiGuide — op-block + responseShape allowlist (closed schema)", () => {
	// Round-trip tripwire — see the ROUNDTRIP_FM block comment for the
	// drift directions this closes.
	it("every OP_ALLOWLIST + RESPONSE_SHAPE_ALLOWLIST key parses and lands", () => {
		const fm = roundtripFm();
		const op = (fm["operations"] as Record<string, unknown>[])[0]!;
		expect(Object.keys(op).sort()).toEqual([...OP_ALLOWLIST].sort());
		expect(
			Object.keys(fm["responseShape"] as Record<string, unknown>).sort(),
		).toEqual([...RESPONSE_SHAPE_ALLOWLIST].sort());
		expect(Object.keys(op["parse"] as Record<string, unknown>).sort()).toEqual(
			[...RESPONSE_SHAPE_ALLOWLIST].sort(),
		);

		const getAll = roundtripGuide().operations[0]!;
		expect(getAll.name).toBe("getAll");
		expect(getAll.via).toBe("paginate");
		expect(getAll.path).toBe("/things");
		expect(getAll.accept).toBe("json");
		expect(Object.keys(getAll.params).sort()).toEqual(["from", "kind"]);
		expect(getAll.requiresAnyOf).toEqual(["kind"]);
		expect(getAll.dateParams).toEqual({ from: "iso8601" });
		expect(getAll.helper).toBe(true);
		expect(getAll.transform).toBe(true);
		expect(getAll.passthrough).toBe(true);
		expect(getAll.parse).toEqual({ format: "json", charset: "utf-8" });
		expect(getAll.errorPath).toBe("error");
		expect(getAll.pagination?.style).toBe("offset-limit");
		expect(getAll.gatherAllMax).toBe(7);
	});

	// The backlog's worst case: a typo'd error envelope parses clean and
	// never fires — the guide returns data while the author believes
	// 200-with-error pages are caught. The allowlist must catch it at parse.
	it("typo'd op key (errorPaths:) → ParseError naming the key", () => {
		const err = expectErr(
			MINIMAL.replace(
				"    path: /things/{id}",
				'    path: /things/{id}\n    errorPaths: "detail"',
			),
		);
		expect(err.field).toBe("operations[0].errorPaths");
		expect(err.expected).toContain("known op-block key");
		expect(err.expected).toContain("errorPath"); // pointer to the valid keys
		expect(err.found).toContain("errorPaths");
	});

	it("unknown guide-level responseShape key → ParseError", () => {
		const err = expectErr(
			MINIMAL.replace(
				"apiHost: https://api.example.com/v1",
				"apiHost: https://api.example.com/v1\nresponseShape:\n  format: json\n  charSet: utf-8",
			),
		);
		expect(err.field).toBe("responseShape.charSet");
		expect(err.expected).toContain("known responseShape key");
	});

	it("op-level parse override with an unknown key → ParseError", () => {
		const err = expectErr(
			MINIMAL.replace(
				"    path: /things/{id}",
				"    path: /things/{id}\n    parse:\n      format: json\n      encoding: utf-8",
			),
		);
		expect(err.field).toBe("operations[0].parse.encoding");
		expect(err.expected).toContain("known responseShape key");
	});

	it("minimal known-good guide still parses (op + responseShape surfaces)", () => {
		const guide = expectOk(MINIMAL.replace("/v1", ""));
		expect(guide.operations[0]!.name).toBe("getThing");
	});
});

describe("parseApiGuide — guide frontmatter allowlist (closed schema)", () => {
	// Round-trip tripwire — same fixture, guide-side assertions. Deliberately
	// NOT Object.keys(const guide) for the landed side: the parsed object
	// drags in derived non-authored fields (`content`, `category`, `source`).
	it("every GUIDE_ALLOWLIST key is authored, accepted, and lands on the guide", () => {
		expect(Object.keys(roundtripFm()).sort()).toEqual(
			[...GUIDE_ALLOWLIST].sort(),
		);

		const guide = roundtripGuide();
		expect(guide.kind).toBe("api");
		expect(guide.domains).toEqual(["roundtrip.example"]);
		expect(guide.shortName).toBe("RoundTrip");
		expect(guide.updated).toBe("2026-01-02");
		expect(guide.icon).toBe("🧪");
		expect(guide.apiHost).toBe("https://api.roundtrip.example/v1");
		expect(guide.verified).toBe("2026-01-02");
		expect(guide.docs).toBe("https://docs.roundtrip.example");
		expect(guide.organization).toBe("RoundTrip Org");
		expect(guide.description).toBe("one guide carrying every allowlisted key");
		expect(guide.schemaVersion).toBe(1);
		expect(guide.gatherAllMax).toBe(42);
		expect(guide.auth).toEqual({ kind: "none" });
		expect(guide.responseShape).toEqual({
			format: "xml",
			charset: "iso-8859-1",
		});
		expect(guide.pagination?.style).toBe("page");
		expect(guide.pagination?.pageParam).toBe("p");
		expect(guide.operations).toHaveLength(1);
	});

	// A typo'd top-level key (the plan's example: `operations:` typo'd) is
	// silently ignored today — the guide parses with zero operations.
	it("typo'd frontmatter key (operationss:) → ParseError naming the key", () => {
		const err = expectErr(MINIMAL.replace("operations:", "operationss:"));
		expect(err.field).toBe("operationss");
		expect(err.expected).toContain("known frontmatter key");
		expect(err.expected).toContain("operations"); // pointer to the valid keys
		expect(err.found).toContain("operationss");
	});

	it("multiple unknown frontmatter keys are all named in the error", () => {
		const err = expectErr(
			MINIMAL.replace(
				"domains: [example.com]",
				"domains: [example.com]\ntotallyUnknownGuideKey: true\nanotherStrayKey: 2",
			),
		);
		expect(err.found).toContain("totallyUnknownGuideKey");
		expect(err.found).toContain("anotherStrayKey");
	});

	it("minimal known-good guide still parses (frontmatter surface)", () => {
		const guide = expectOk(MINIMAL);
		expect(guide.domains).toEqual(["example.com"]);
		expect(guide.operations).toHaveLength(1);
	});
});

describe("parseApiGuide — secretPathRefs", () => {
	function guideWithOps(authYaml: string, opsYaml: string) {
		return `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com
auth:
${authYaml}
operations:
${opsYaml}
---
body
`;
	}

	const tokenOps = `  - name: get
    via: restGet
    path: /auth{token}/get
    accept: json
  - name: list
    via: restGet
    path: /auth{token}/list
    accept: json`;

	it("a valid path-token guide parses (secret-owned {token} in paths)", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key`,
				tokenOps,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(true);
		if (r.ok && r.guide.auth.kind === "static-key") {
			expect(r.guide.auth.secretPathRefs).toEqual({
				token: { secret: "path_key" },
			});
		}
	});

	it("a docs-only params.<name>.description entry stays legal", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key`,
				`  - name: get
    via: restGet
    path: /auth{token}/get
    accept: json
    params:
      token:
        description: the auth token`,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(true);
	});

	it("a name in an op's params map → ParseError (agent-suppliable collision)", () => {
		// The op's path lacks {token}, so `params.token` is a real query-param
		// entry reaching dOp.params — the in-params collision.
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key`,
				`  - name: list
    via: restGet
    path: /things
    accept: json
    params:
      token:
        required: true`,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretPathRefs.token");
			expect(r.error.fix).toContain("agent must not be able to set it");
		}
	});

	it("a name in no op's path → ParseError (declared-but-unused typo)", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key`,
				`  - name: list
    via: restGet
    path: /things
    accept: json`,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretPathRefs.token");
			expect(r.error.found).toContain("no operation's path contains {token}");
		}
	});

	it("a name shared with secretQueryRefs → ParseError (cross-map shared key)", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key
  secretQueryRefs:
    token:
      secret: query_token`,
				`  - name: get
    via: restGet
    path: /auth{token}/get
    accept: json`,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretPathRefs.token");
			expect(r.error.fix).toContain("both secretPathRefs and secretQueryRefs");
		}
	});

	it("an `optional` key on a path ref → ParseError (required-only, presence rejected)", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key
      optional: true`,
				tokenOps,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.secretPathRefs.token.optional");
	});

	it("a `prefix` on a path ref → ParseError (path injection is the raw value)", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key
      prefix: "Bearer "`,
				tokenOps,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.secretPathRefs.token.prefix");
	});

	it("a non-\\w ref name → ParseError with the {\\w+} grammar message", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    bad-name:
      secret: path_key`,
				tokenOps,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.field).toBe("auth.secretPathRefs.bad-name");
			expect(r.error.expected).toContain("\\w+");
		}
	});

	it("an unknown auth key next to secretPathRefs → ParseError (allowlist typo)", () => {
		const r = parseApiGuide(
			guideWithOps(
				`  kind: static-key
  secretPathRefs:
    token:
      secret: path_key
  secretPathRef:
    token:
      secret: path_key`,
				tokenOps,
			),
			{ filename: "example.com" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.field).toBe("auth.secretPathRef");
	});
});

// ═══════════════════════════════════════════════════════════════════
// listStyle — multi-value query params (schema field + parser rules)
// ═══════════════════════════════════════════════════════════════════

function listStyleGuide(opYaml: string, topPagination = ""): string {
	return `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
${topPagination}
operations:
${opYaml}
---
Prose body.
`;
}

const LISTSTYLE_OP = `  - name: search
    via: restGet
    path: /search
    params:
      labels:
        listStyle: comma
`;

describe("parseApiGuide — listStyle", () => {
	it("accepts a listStyle param and parses it onto the spec", () => {
		const guide = expectOk(listStyleGuide(LISTSTYLE_OP), {
			filename: "example.com",
		});
		expect(guide.operations[0]!.params["labels"]!.listStyle).toBe("comma");
	});

	it("accepts all three enum values", () => {
		for (const style of ["comma", "repeat", "bracket"] as const) {
			const guide = expectOk(
				listStyleGuide(LISTSTYLE_OP.replace("comma", style)),
				{ filename: "example.com" },
			);
			expect(guide.operations[0]!.params["labels"]!.listStyle).toBe(style);
		}
	});

	it("unknown listStyle value → ParseError naming the valid values", () => {
		const err = expectErr(listStyleGuide(LISTSTYLE_OP.replace("comma", "csv")), {
			filename: "example.com",
		});
		expect(err.field).toBe("operations[0].params.labels.listStyle");
		expect(err.expected).toContain("comma | repeat | bracket");
	});

	it("listStyle on a path param → ParseError (docs-only routing)", () => {
		const err = expectErr(
			listStyleGuide(`  - name: getThing
    via: restGet
    path: /things/{id}
    params:
      id:
        listStyle: comma
`),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.id");
		expect(err.expected).toContain("docs-only");
	});

	it("bracket on a param name already ending in [] → ParseError (double-dress)", () => {
		const err = expectErr(
			listStyleGuide(
				LISTSTYLE_OP.replace("labels", "id[]").replace("comma", "bracket"),
			),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.id[].listStyle");
		expect(err.found).toContain("double-dress");
	});

	it("array default on a non-listStyle param → ParseError (every-call-throw class)", () => {
		const err = expectErr(
			listStyleGuide(
				LISTSTYLE_OP.replace(/listStyle: comma\n/, "").replace(
					"      labels:",
					"      labels:\n        default: [bug, help wanted]",
				),
			),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.labels.default");
		expect(err.expected).toContain("requires listStyle");
	});

	it("array default on a listStyle param parses cleanly", () => {
		const guide = expectOk(
			listStyleGuide(
				LISTSTYLE_OP.replace(
					"listStyle: comma",
					"listStyle: comma\n        default: [bug, docs]",
				),
			),
			{ filename: "example.com" },
		);
		expect(guide.operations[0]!.params["labels"]!.default).toEqual([
			"bug",
			"docs",
		]);
	});

	it("empty array default on a listStyle param → ParseError (every-defaulted-call-throw class)", () => {
		const err = expectErr(
			listStyleGuide(
				LISTSTYLE_OP.replace(
					"listStyle: comma",
					"listStyle: comma\n        default: []",
				),
			),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.labels.default");
		expect(err.expected).toContain("non-empty array default");
	});

	it("array default with a non-scalar element → ParseError", () => {
		const err = expectErr(
			listStyleGuide(
				LISTSTYLE_OP.replace(
					"listStyle: comma",
					"listStyle: repeat\n        default: [ok, [nested, thing]]",
				),
			),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.labels.default");
		expect(err.expected).toContain("scalar");
	});

	it("array default with a comma-bearing element on a comma param → ParseError", () => {
		const err = expectErr(
			listStyleGuide(
				LISTSTYLE_OP.replace(
					"listStyle: comma",
					`listStyle: comma\n        default: ["a,b", "c"]`,
				),
			),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.labels.default");
		expect(err.expected).toContain("comma-free");
	});

	it("comma-bearing element is fine on a repeat param", () => {
		const guide = expectOk(
			listStyleGuide(
				LISTSTYLE_OP.replace(
					"listStyle: comma",
					`listStyle: repeat\n        default: ["a,b", "c"]`,
				),
			),
			{ filename: "example.com" },
		);
		expect(guide.operations[0]!.params["labels"]!.default).toEqual(["a,b", "c"]);
	});

	it("unknown param-spec key → ParseError (tripwire)", () => {
		const err = expectErr(
			listStyleGuide(LISTSTYLE_OP.replace("listStyle: comma", "listStyl: comma")),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.labels.listStyl");
		expect(err.expected).toContain("unknown param-spec key");
	});

	it("typo'd required key → ParseError (the silent-drop class)", () => {
		const err = expectErr(
			listStyleGuide(`  - name: search
    via: restGet
    path: /search
    params:
      q:
        requried: true
`),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.q.requried");
	});

	it("scalar collision with pagination wire name stays legal (seeded pattern)", () => {
		const guide = expectOk(
			listStyleGuide(`  - name: list
    via: paginate
    path: /items
    params:
      page:
        default: 0
    pagination:
      style: page
      pageParam: page
      pageSizeParam: per_page
      itemsPath: data
`),
			{ filename: "example.com" },
		);
		expect(guide.operations[0]!.params["page"]!.default).toBe(0);
	});

	it("listStyle param colliding with an op-level pagination wire name → ParseError", () => {
		const err = expectErr(
			listStyleGuide(`  - name: list
    via: paginate
    path: /items
    params:
      page:
        listStyle: repeat
    pagination:
      style: page
      pageParam: page
      pageSizeParam: per_page
      itemsPath: data
`),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.page.listStyle");
		expect(err.found).toContain("pagination");
	});

	it("listStyle colliding with a guide-level pageParam → ParseError", () => {
		const err = expectErr(
			listStyleGuide(
				`  - name: list
    via: paginate
    path: /items
    params:
      page:
        listStyle: repeat
`,
				`pagination:
  style: page
  pageParam: page
  pageSizeParam: per_page
  itemsPath: data
`,
			),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("operations[0].params.page.listStyle");
	});

	it("restGet op + guide-level pagination + colliding name parses (supersession is paginate-only)", () => {
		const guide = expectOk(
			listStyleGuide(
				`  - name: search
    via: restGet
    path: /search
    params:
      page:
        listStyle: repeat
`,
				`pagination:
  style: page
  pageParam: page
  pageSizeParam: per_page
  itemsPath: data
`,
			),
			{ filename: "example.com" },
		);
		// The paginate loop is the only supersession site — a restGet op's
		// params are never replaced, so the guide-level pageParam name is
		// free to take a listStyle here.
		expect(guide.operations[0]!.params["page"]!.listStyle).toBe("repeat");
	});

	it("listStyle colliding with a tokenBag continuation wire name → ParseError", () => {
		const err = expectErr(
			listStyleGuide(`  - name: list
    via: paginate
    path: /items
    params:
      rccontinue:
        listStyle: comma
    pagination:
      style: tokenBag
      itemsPath: query
      continuationParams:
        - continue.rccontinue
`),
			{ filename: "example.com" },
		);
		// The wire name derives from the last dot segment of the continuation
		// path (continue.rccontinue → rccontinue), not the declared param.
		expect(err.field).toBe("operations[0].params.rccontinue.listStyle");
	});
});

// ═════════════════════════════════════════════════════════════════
// Injected query-secret names vs pagination wire names (paginate ops)
// ═════════════════════════════════════════════════════════════════

describe("parseApiGuide — secretQueryRefs vs pagination wire names", () => {
	// The paginate URL is built as { ...pageParams, ...secretParams } — the
	// secret spreads last and overwrites the pagination value on every page
	// request, so pagination silently never advances past page one.
	const secretGuide = (opYaml: string, topPagination = "") => `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
auth:
  kind: static-key
  secretQueryRefs:
    page:
      secret: api_key
${topPagination}
operations:
${opYaml}
---
Prose body.
`;

	const PAGE_PAGINATION = `pagination:
  style: page
  pageParam: page
  pageSizeParam: per_page
  itemsPath: data
`;

	it("paginate op: secretQueryRefs name colliding with pageParam → ParseError", () => {
		const err = expectErr(
			secretGuide(
				`  - name: list
    via: paginate
    path: /items
`,
				PAGE_PAGINATION,
			),
			{ filename: "example.com" },
		);
		expect(err.field).toBe("auth.secretQueryRefs.page");
		expect(err.found).toContain('"page" is a pagination wire param');
		expect(err.found).toContain(
			"overwrites the pagination value on every page request",
		);
		expect(err.fix).toContain("Rename the secret ref");
	});

	it("tokenBag continuation wire name collides too", () => {
		const err = expectErr(
			secretGuide(`  - name: list
    via: paginate
    path: /items
    pagination:
      style: tokenBag
      itemsPath: query
      continuationParams:
        - continue.page
`),
			{ filename: "example.com" },
		);
		// continue.page → wire name "page" (last dot segment), which the
		// secretQueryRefs ref above also claims.
		expect(err.field).toBe("auth.secretQueryRefs.page");
	});

	it("restGet op with the same collision stays legal (supersession is paginate-only)", () => {
		const guide = expectOk(
			secretGuide(
				`  - name: search
    via: restGet
    path: /search
`,
				PAGE_PAGINATION,
			),
			{ filename: "example.com" },
		);
		expect(guide.operations[0]!.via).toBe("restGet");
	});

	it("oauth2 paramStyle: query injects access_token — colliding wire name → ParseError", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://auth.example.com/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
  paramStyle: query
pagination:
  style: page
  pageParam: access_token
  pageSizeParam: per_page
  itemsPath: data
operations:
  - name: list
    via: paginate
    path: /items
---
Prose body.
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("auth.paramStyle");
		expect(err.found).toContain("overwrites the pagination value");
		expect(err.fix).toContain("bearer-header");
	});

	it("oauth2 default paramStyle (bearer-header) with an access_token pageParam parses", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://auth.example.com/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
pagination:
  style: page
  pageParam: access_token
  pageSizeParam: per_page
  itemsPath: data
operations:
  - name: list
    via: paginate
    path: /items
---
Prose body.
`;
		const guide = expectOk(raw, { filename: "example.com" });
		expect(guide.pagination?.pageParam).toBe("access_token");
	});

	it("non-colliding static-key paginate op parses (negative control)", () => {
		const guide = expectOk(
			secretGuide(
				`  - name: list
    via: paginate
    path: /items
`,
				PAGE_PAGINATION.replace("pageParam: page", "pageParam: offset"),
			),
			{ filename: "example.com" },
		);
		expect(guide.operations[0]!.via).toBe("paginate");
	});
});

// ═════════════════════════════════════════════════════════════════
// oauth2 paramStyle: query — injected access_token vs declared op params
// (restGet arm of the D1 cross-field check)
// ═════════════════════════════════════════════════════════════════

describe("parseApiGuide — oauth2 query access_token vs op params", () => {
	const OAUTH2_QUERY_AUTH = `auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://auth.example.com/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
  paramStyle: query
`;

	it("restGet op declaring params.access_token → ParseError (injected param is agent-suppliable collision)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
${OAUTH2_QUERY_AUTH}operations:
  - name: search
    via: restGet
    path: /search
    params:
      access_token:
        required: true
---
Prose body.
`;
		const err = expectErr(raw, { filename: "example.com" });
		expect(err.field).toBe("auth.paramStyle");
		expect(err.found).toContain('also a param of operation "search"');
		expect(err.fix).toContain("code-injected from the token store");
	});

	it("bearer-header (default) with the same params.access_token stays legal", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
auth:
  kind: oauth2
  grant: client_credentials
  tokenUrl: https://auth.example.com/token
  clientId: { secret: my_client }
  clientSecret: { secret: client_secret }
operations:
  - name: search
    via: restGet
    path: /search
    params:
      access_token:
        required: true
---
Prose body.
`;
		const guide = expectOk(raw, { filename: "example.com" });
		expect(guide.operations[0]!.name).toBe("search");
	});

	it("passthrough op with an undeclared caller-supplied access_token stays legal (runtime skips injected names)", () => {
		const raw = `---
schemaVersion: 1
domains: [example.com]
apiHost: https://api.example.com/v1
${OAUTH2_QUERY_AUTH}operations:
  - name: query
    via: restGet
    path: /query
    passthrough: true
---
Prose body.
`;
		const guide = expectOk(raw, { filename: "example.com" });
		expect(guide.operations[0]!.passthrough).toBe(true);
	});
});
