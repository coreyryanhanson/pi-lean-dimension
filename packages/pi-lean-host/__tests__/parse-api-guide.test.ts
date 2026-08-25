/**
 * parseApiGuide() schema & parser tests.
 *
 * Covers:
 *  - BOE worked example parses to a valid ApiGuide with defaults filled.
 *  - Each malformed fixture returns a ParseError with dotted field path.

 *  - projectToGuide() strips recipe fields, retains kind: "api".
 *  - Catalog rendering lists healthy + ⚠ malformed together.
 */

import { describe, it, expect, vi } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseApiGuide,
	projectToGuide,
	loadApiGuidesFromDir,
	formatApiGuideCatalog,
	stampFrontmatterField,
} from "../core/parse-api-guide.js";
import { slug } from "../core/path-template.js";
import {
	GATHER_ALL_MAX_FALLBACK,
	type ApiGuide,
	type ParseError,
} from "../core/api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Worked example (the BOE API shape)
// ═══════════════════════════════════════════════════════════════════

const BOE_RECIPE = `---
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

// ═══════════════════════════════════════════════════════════════════
// docs — optional API documentation URL
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — docs field", () => {
	it("accepts an http/https docs URL", () => {
		const raw = `---
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

	it("unknown auth key (name/secret wrong shape) → ParseError with fix pointing at secretRefs/requires", () => {
		const raw = `---
domains: [example.com]
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
body
`;
		const err = expectErr(raw);
		expect(err.field).toBe("auth.name");
		expect(err.found).toBe("unknown key(s): name, secret");
		expect(err.fix).toContain("secretRefs");
		expect(err.fix).toContain("requires");
	});

	it("near-miss auth key (requiers:) → fix says did you mean requires", () => {
		const raw = `---
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
		expect(err.fix).toContain('did you mean "requires"?');
	});

	it("paginate op with no pagination → ParseError", () => {
		const raw = `---
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

		it("rejects a requiresAnyOf member that carries a default (mutually exclusive peers)", () => {
			const raw = `---
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
			expect(err.fix).toContain("mutually exclusive peers");
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
		expect(err.found).toContain("line 9, column 22: `");
		expect(err.found).toContain("line 11, column 22: `");
		expect(err.fix).toContain("Quote the value");
	});

	it("backtick mid-value (not at start) → parses fine, no pre-scan hit", () => {
		const raw = `---
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

	it("resumptionToken missing tokenParam → ParseError", () => {
		const raw = `---
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

// ═══════════════════════════════════════════════════════════════════
// dateParams — valid and invalid
// ═══════════════════════════════════════════════════════════════════

describe("parseApiGuide — dateParams", () => {
	it("parses valid dateParams on an operation", () => {
		const raw = `---
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

	it("accepts operation without dateParams", () => {
		const raw = `---
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

// ═══════════════════════════════════════════════════════════════════
// projectToGuide — strips recipe, retains presentation + kind
// ═══════════════════════════════════════════════════════════════════

describe("projectToGuide", () => {
	it("strips recipe fields and retains kind: api", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });
		const proj = projectToGuide(guide);

		const keys = Object.keys(proj);
		const RECIPE_KEYS = [
			"apiHost",
			"operations",
			"pagination",
			"auth",
			"helper",
			"verified",
			"gatherAllMax",
			"responseShape",
		];
		for (const k of RECIPE_KEYS) {
			expect(keys).not.toContain(k);
		}

		expect(proj.kind).toBe("api");
		expect(proj.domains).toEqual(["boe.es", "www.boe.es"]);
		expect(proj.icon).toBe("⚖️");
		expect(proj.shortName).toBe("BOE");
		expect(proj.updated).toBe("2026-07-17");
		expect(proj.content).toContain("BOE Legislación Consolidada");
		expect(proj.category).toBe("site");
	});

	it("projection carries no helper reference", () => {
		const guide = expectOk(BOE_RECIPE, { filename: "boe.es" });
		const proj = projectToGuide(guide);
		// Helper is a recipe (op-level) field; the Guide projection has no such key.
		expect("helper" in proj).toBe(false);
		expect("operations" in proj).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════
// slug() — the shortName → identity-folder sanitizer
// ═══════════════════════════════════════════════════════════════════

describe("slug()", () => {
	it("lowercases and replaces non-[a-z0-9-] runs with a single '-'", () => {
		expect(slug("BOE")).toBe("boe");
		expect(slug("CoinMarketCap Pro!")).toBe("coinmarketcap-pro");
		expect(slug("a/b")).toBe("a-b");
	});

	it("transliterates Latin diacritics instead of dropping them", () => {
		expect(slug("Café")).toBe("cafe");
		expect(slug("Überwald")).toBe("uberwald");
		expect(slug("Bjørk")).toBe("bjork");
		expect(slug("Münchhausen")).toBe("munchhausen");
	});

	it("collapses repeated '-' and strips leading/trailing '-'", () => {
		expect(slug("a--b")).toBe("a-b");
		expect(slug("-foo-")).toBe("foo");
	});

	it("slug-collision pair: cmc_full and cmc-full both slug to cmc-full", () => {
		expect(slug("cmc_full")).toBe("cmc-full");
		expect(slug("cmc-full")).toBe("cmc-full");
	});

	it("throws on empty or all-symbol shortName (slug flattens to empty)", () => {
		expect(() => slug("")).toThrow(/shortName/);
		expect(() => slug("!!!")).toThrow(/shortName/);
		expect(() => slug("..")).toThrow(/shortName/);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Loader + catalog — one malformed guide doesn't block the store
// ═══════════════════════════════════════════════════════════════════

describe("loadApiGuidesFromDir + formatApiGuideCatalog", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists a healthy and a malformed guide together", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			// Healthy guide in subdirectory
			const boeDir = join(dir, "boe");
			mkdirSync(boeDir, { recursive: true });
			writeFileSync(join(boeDir, "guide.md"), BOE_RECIPE);

			// Malformed guide in subdirectory
			const brokenDir = join(dir, "broken");
			mkdirSync(brokenDir, { recursive: true });
			writeFileSync(
				join(brokenDir, "guide.md"),
				`---
domains: [broken.com]
apiHost: https://api.broken.com
operations:
  - name: get
    via: restPost
    path: /things
---
body
`,
			);

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
			expect(loaded.malformed).toHaveLength(1);
			expect(loaded.malformed[0]!.filename).toBe("broken");
			expect(loaded.malformed[0]!.error.field).toBe("operations[0].via");

			const catalog = formatApiGuideCatalog(loaded);
			expect(catalog).toContain("BOE");
			expect(catalog).toContain("⚠ malformed");
			expect(catalog).toContain("broken");
			expect(catalog).toContain("operations[0].via");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("collapses the catalog by organization (org line + orgless fallback)", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			const orgRecipe = (d: string, shortName: string, domains: string) => `---
kind: api
domains: [${domains}]
organization: archive.org
description: ${shortName} surface.
icon: 🏛️
shortName: ${shortName}
updated: 2026-07-17
apiHost: https://${d}
verified: 2026-07-17
gatherAllMax: 500
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: get
    via: restGet
    path: /x
    accept: json
---
org guide.
`;
			for (const [domain, folder, shortName] of [
				["archive.org", "archive", "Archive"],
				["web.archive.org", "wayback", "Wayback"],
			] as const) {
				mkdirSync(join(dir, folder), { recursive: true });
				writeFileSync(
					join(dir, folder, "guide.md"),
					orgRecipe(domain, shortName, domain),
				);
			}
			// Orgless guide keeps the per-guide line (fallback).
			mkdirSync(join(dir, "boe"), { recursive: true });
			writeFileSync(join(dir, "boe", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir);
			const catalog = formatApiGuideCatalog(loaded);
			// One org-collapsed line for archive.org with guide count + domain set.
			expect(catalog).toContain(
				"🏛️ archive.org — 2 guides (archive.org, web.archive.org)",
			);
			// Orgless BOE keeps the per-guide shape (icon + shortName + ops).
			expect(catalog).toContain("⚖️ BOE — boe.es, www.boe.es");
			expect(catalog).not.toContain("🏛️ BOE");
			// Footer mentions the disambiguation menu.
			expect(catalog).toContain("disambiguation menu");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty result for a nonexistent directory", () => {
		const loaded = loadApiGuidesFromDir(
			join(tmpdir(), "host-guides-nonexistent-xyz"),
		);
		expect(loaded.guides).toEqual({});
		expect(loaded.malformed).toEqual([]);
		expect(formatApiGuideCatalog(loaded)).toContain("no guides");
	});

	it("skips subdirectories without guide.md", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			// A subdir without guide.md — skipped
			mkdirSync(join(dir, "no-guide"), { recursive: true });
			writeFileSync(join(dir, "no-guide", "helper.ts"), "export default p => p;");

			// A valid subdir with guide.md — loaded
			mkdirSync(join(dir, "boe"), { recursive: true });
			writeFileSync(join(dir, "boe", "guide.md"), BOE_RECIPE);

			// Flat .md files at top level — ignored
			writeFileSync(join(dir, "README.txt"), "not a guide");

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes a divergent folder (entry !== slug(shortName)) to malformed", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// BOE_RECIPE has shortName: BOE → slug "boe"; folder is "boe.es" —
			// the pre-migration state. Under enforcement the guide does NOT load.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual([]);
			expect(loaded.malformed).toHaveLength(1);
			expect(loaded.malformed[0]!.filename).toBe("boe.es");
			expect(loaded.malformed[0]!.error.field).toBe("shortName");
			expect(loaded.malformed[0]!.error.found).toBe("folder 'boe.es'");
			expect(loaded.malformed[0]!.error.fix).toContain("mv");
			expect(loaded.malformed[0]!.error.fix).toContain("boe");
			// The per-guide fix names the mv only; the /reload instruction lives
			// in the migration banner, not on each path line.
			expect(loaded.malformed[0]!.error.fix).not.toContain("/reload");
			// The malformed guide is warned about at load, and the catalog
			// renders its actionable fix (the migration instruction).
			const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
			expect(msg).toContain("Malformed guide");
			expect(msg).toContain("boe.es");
			// The one-shot migration banner carries the 0.4.0 structure-change
			// explanation + /reload, and precedes the per-guide warnings.
			expect(msg).toContain(
				"pi-lean-host 0.4.0 changed the guide folder structure",
			);
			expect(msg).toContain("/reload");
			expect(msg.indexOf("pi-lean-host 0.4.0 changed")).toBeLessThan(
				msg.indexOf("Malformed guide"),
			);
			const catalog = formatApiGuideCatalog(loaded);
			expect(catalog).toContain("fix:");
			expect(catalog).not.toContain("/reload");
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes warnings through the notify callback when provided", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const notify = vi.fn();
		try {
			// Divergent folder (boe.es vs slug "boe") — the migration-window
			// state that must surface loudly.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir, notify);
			expect(Object.keys(loaded.guides)).toEqual([]);
			expect(loaded.malformed).toHaveLength(1);
			// The banner + per-guide warning go through notify, not console.warn.
			expect(notify).toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			const msgs = notify.mock.calls.map((c) => String(c[0])).join("\n");
			expect(msgs).toContain(
				"pi-lean-host 0.4.0 changed the guide folder structure",
			);
			expect(msgs).toContain("Malformed guide");
			expect(msgs).toContain("boe.es");
			// Every notify call uses the warning kind (ctx.ui.notify signature).
			expect(notify.mock.calls.every((c) => c[1] === "warning")).toBe(true);
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("warns on duplicate shortName across folders during the migration window", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Two divergent folders declaring the same shortName (migration-window
			// collision). The duplicate warning names both; enforcement routes
			// both to malformed (neither loads).
			for (const f of ["alpha", "beta"]) {
				mkdirSync(join(dir, f), { recursive: true });
				writeFileSync(join(dir, f, "guide.md"), BOE_RECIPE);
			}

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual([]);
			expect(loaded.malformed).toHaveLength(2);
			const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
			expect(msg).toContain("Duplicate shortName");
			expect(msg).toContain("alpha");
			expect(msg).toContain("beta");
			expect(msg).toContain("/api delete");
			// The migration banner fires once, not once per malformed guide.
			expect(
				msg.match(/pi-lean-host 0\.4\.0 changed the guide folder structure/g),
			).toHaveLength(1);
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a divergent + convergent pair sharing shortName warns and loads only the convergent one", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Old divergent folder (pre-migration) + new convergent folder
			// (slug). The duplicate warning names both; only the convergent one
			// loads — the guarantee holds.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);
			mkdirSync(join(dir, "boe"), { recursive: true });
			writeFileSync(join(dir, "boe", "guide.md"), BOE_RECIPE);

			const loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
			expect(loaded.malformed).toHaveLength(1);
			const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
			expect(msg).toContain("Duplicate shortName");
			expect(msg).toContain("boe.es");
			expect(msg).toContain("boe");
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes an empty/all-symbol shortName to malformed without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			for (const bad of ["'!!!'", "''"]) {
				mkdirSync(join(dir, "bad"), { recursive: true });
				writeFileSync(
					join(dir, "bad", "guide.md"),
					BOE_RECIPE.replace("shortName: BOE", `shortName: ${bad}`),
				);

				const loaded = loadApiGuidesFromDir(dir);
				expect(Object.keys(loaded.guides)).toEqual([]);
				expect(loaded.malformed).toHaveLength(1);
				expect(loaded.malformed[0]!.filename).toBe("bad");
				expect(loaded.malformed[0]!.error.field).toBe("shortName");
				expect(loaded.malformed[0]!.error.fix).toContain("shortName");
				rmSync(join(dir, "bad"), { recursive: true, force: true });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a divergent guide loads after an agent-assisted rename to slug(shortName)", () => {
		const dir = mkdtempSync(join(tmpdir(), "host-guides-"));
		try {
			// BOE_RECIPE has shortName: BOE → slug "boe"; folder is "boe.es" —
			// the pre-migration state routes to malformed.
			mkdirSync(join(dir, "boe.es"), { recursive: true });
			writeFileSync(join(dir, "boe.es", "guide.md"), BOE_RECIPE);
			let loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual([]);
			expect(loaded.malformed).toHaveLength(1);

			// The migration instruction (mv boe.es boe); /reload lives in the banner.
			renameSync(join(dir, "boe.es"), join(dir, "boe"));
			loaded = loadApiGuidesFromDir(dir);
			expect(Object.keys(loaded.guides)).toEqual(["boe"]);
			expect(loaded.malformed).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// stampFrontmatterField — save-stamp blank-line separation (G3)
// ═══════════════════════════════════════════════════════════════════

describe("stampFrontmatterField", () => {
	it("inserts a blank line before a new key when the preceding line is non-empty", () => {
		const out = stampFrontmatterField(
			"---\nfoo: bar\n---\n",
			"schemaVersion",
			"0",
		);
		expect(out).toBe("---\nfoo: bar\n\nschemaVersion: 0\n---\n");
	});

	it("does not double-blank when the preceding line is already empty", () => {
		const out = stampFrontmatterField(
			"---\nfoo: bar\n\n---\n",
			"schemaVersion",
			"0",
		);
		expect(out).toBe("---\nfoo: bar\n\nschemaVersion: 0\n---\n");
	});

	it("replaces an existing key without introducing a blank line (idempotent re-stamp)", () => {
		const out = stampFrontmatterField(
			"---\nfoo: bar\nschemaVersion: 0\n---\n",
			"schemaVersion",
			"1",
		);
		expect(out).toBe("---\nfoo: bar\nschemaVersion: 1\n---\n");
	});
});
