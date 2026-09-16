/**
 * `parseApiGuide()` — the single parser both `api-learn` (validate-before-
 * write) and the loader (read-from-disk) route through. One parser, two call
 * sites (design: "One parser, two call sites").
 *
 * Uses a real YAML parser for the nested `operations` / `auth` / `pagination`
 * / `responseShape` blocks — portal's flat `key: value` splitter cannot handle
 * them and is intentionally not reused (design: "Parser split").
 */

import { parse as yamlParse } from "yaml";
import { fileURLToPath } from "node:url";
import {
	extractPathTokens,
	tokenizeJsonPath,
	wireParamName,
} from "./path-template.js";
import {
	GATHER_ALL_MAX_FALLBACK,
	GUIDE_SCHEMA_VERSION,
	KNOWN_AUTH_KINDS,
	type ApiGuide,
	type DateParamFormat,
	type ParseError,
	type ParseApiGuideResult,
	type ParseApiGuideOptions,
	type Operation,
	type PaginationConfig,
	type PaginationStyle,
	type ResponseShape,
	type ResponseFormat,
	type ResponseCharset,
	type AuthConfig,
	type AuthKind,
	type SecretRef,
	type StaticKeyAuth,
	type OAuth2Auth,
	type OAuth2ParamStyle,
	type OAuth2TokenEndpointAuthMethod,
	isOAuth2Grant,
	isOAuth2TokenEndpointAuthMethod,
	isListStyle,
	LIST_STYLES,
	oauth2GrantIssue,
	OAUTH2_GRANTS,
	OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS,
	type ExecutorVia,
	type AcceptType,
	type QueryParamSpec,
} from "./api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Frontmatter split
// ═══════════════════════════════════════════════════════════════════

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * Line-level frontmatter stamp — replace (or insert) a single `key: value`
 * line inside the isolated frontmatter block, preserving comments and key
 * order (no YAML round-trip — a round-trip reformats and strips comments).
 * Used by api-learn (schemaVersion save-stamp) and /api verify (verified
 * stamp). Returns the document unchanged when it has no frontmatter block.
 */
export function stampFrontmatterField(
	raw: string,
	key: string,
	value: string,
): string {
	const match = raw.match(FRONTMATTER_RE);
	if (!match) return raw;
	const fm = match[1] ?? "";
	const content = match[2] ?? "";
	const nl = /^---(\r?\n)/.exec(raw)?.[1] ?? "\n";
	const lines = fm.split(nl);
	const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
	const line = `${key}: ${value}`;
	if (idx === -1) {
		// Insert-only separation: a new key would land flush against the
		// preceding line (e.g. under the last op's params block). Push a
		// blank line first when the preceding line is non-empty. Replace
		// must NOT do this — every /api verify re-stamp would drift the file.
		if (lines.length > 0 && lines.at(-1)?.trim() !== "") {
			lines.push("");
		}
		lines.push(line);
	} else {
		lines[idx] = line;
	}
	return `---${nl}${lines.join(nl)}${nl}---${nl}${content}`;
}

const VALID_VIA: ReadonlySet<string> = new Set(["restGet", "paginate"]);
// Closed param-spec key allowlist — the unknown-key tripwire rejects
// anything else (typo'd `listStyl:` / `requried:` must not silently no-op).
// Exported for the allowlist↔parser tripwire in
// __tests__/parse-api-guide.test.ts (same two-direction shape as
// AUTH_ALLOWLISTS / PAGINATION_ALLOWLISTS).
export const PARAM_SPEC_KEYS: ReadonlySet<string> = new Set([
	"required",
	"default",
	"description",
	"listStyle",
]);
// accept is a free-form string — any media type is valid (`json`/`xml`
// shorthands are mapped by the helper).
const VALID_FORMAT: ReadonlySet<string> = new Set(["json", "xml", "text"]);
const DATE_PARAM_FORMATS: ReadonlySet<string> = new Set([
	"iso8601",
	"yyyymmdd",
	"yyyy-mm-dd",
]);
const VALID_PAGINATION_STYLE: ReadonlySet<string> = new Set([
	"offset-limit",
	"nextLink",
	"cursor",
	"page",
	"resumptionToken",
	"tokenBag",
]);

// Per-variant auth field allowlists — each kind rejects fields not legal for
// it (stricter than the old single global set: a `tokenUrl` on a static-key
// block or a `headerPrefixes` on an oauth2 block now fails at parse). The old
// `none`-kind field-presence check is subsumed by the NoneAuth allowlist.
// Exported for the allowlist↔parser tripwire in __tests__/parse-api-guide.test.ts
// (same two-direction shape as PAGINATION_ALLOWLISTS).
export const AUTH_ALLOWLISTS: Record<AuthKind, ReadonlySet<string>> = {
	none: new Set(["kind", "headers"]),
	"static-key": new Set([
		"kind",
		"headers",
		"secretRefs",
		"secretQueryRefs",
		"secretPathRefs",
	]),
	oauth2: new Set([
		"kind",
		"grant",
		"tokenUrl",
		"clientId",
		"clientSecret",
		"secretRefs",
		"scopes",
		"paramStyle",
		"tokenEndpointAuthMethod",
		"authorizeUrl",
		"revokeUrl",
	]),
};

// Per-style pagination field allowlists — same pattern as AUTH_ALLOWLISTS:
// each style rejects keys not legal for it, so a typo (`itemPath:`) or a
// wrong-style key (`cursorPath:` on a nextLink block) fails at parse instead
// of silently single-paging at runtime.
// Post-landing note: any schema change touching pagination fields updates
// these allowlists in the same commit — every future optional pagination
// field must be added to its style's set here (the allowlist↔parser tripwire
// in __tests__/parse-api-guide.test.ts enforces the parser side mechanically).
export const PAGINATION_ALLOWLISTS: Record<
	PaginationStyle,
	ReadonlySet<string>
> = {
	"offset-limit": new Set([
		"style",
		"itemsPath",
		"pageParam",
		"pageSizeParam",
		"pageSize",
		"base",
		"totalCountPath",
		"hasMorePath",
	]),
	page: new Set([
		"style",
		"itemsPath",
		"pageParam",
		"pageSizeParam",
		"pageSize",
		"base",
		"totalCountPath",
		"hasMorePath",
	]),
	nextLink: new Set([
		"style",
		"itemsPath",
		"nextLinkPath",
		"totalCountPath",
		"hasMorePath",
	]),
	cursor: new Set([
		"style",
		"itemsPath",
		"cursorParam",
		"cursorPath",
		"pageSizeParam",
		"pageSize",
		"totalCountPath",
		"hasMorePath",
	]),
	resumptionToken: new Set([
		"style",
		"itemsPath",
		"tokenParam",
		"tokenPath",
		"totalCountPath",
		"hasMorePath",
	]),
	tokenBag: new Set([
		"style",
		"itemsPath",
		"continuationParams",
		"totalCountPath",
		"hasMorePath",
	]),
};

// Op-block key allowlist — the closed-schema pass's largest surface. An
// unknown op key (`errorPaths:` instead of `errorPath:`) used to parse clean
// and silently no-op the intended behavior — worst case, a typo'd error
// envelope never fires. Exported for the allowlist↔parser tripwire in
// __tests__/parse-api-guide.test.ts (same two-direction shape as
// PAGINATION_ALLOWLISTS). Not `pathParamDocs` — that's a parser-derived
// OUTPUT field built from params.<token>.description, never authored.
export const OP_ALLOWLIST: ReadonlySet<string> = new Set([
	"name",
	"via",
	"path",
	"accept",
	"params",
	"requiresAnyOf",
	"dateParams",
	"helper",
	"transform",
	"passthrough",
	"parse",
	"errorPath",
	"pagination",
	"gatherAllMax",
]);

// responseShape block allowlist — same closed-schema pass, same philosophy:
// only `format` and `charset` are read; anything else is a typo.
// Exported for the allowlist↔parser tripwire in
// __tests__/parse-api-guide.test.ts.
export const RESPONSE_SHAPE_ALLOWLIST: ReadonlySet<string> = new Set([
	"format",
	"charset",
]);

// Guide-frontmatter key allowlist — the closed-schema pass's third surface.
// Exactly the 16 keys parseApiGuide reads from the parsed YAML mapping: the
// 15 literal m["…"] sites plus `domains` (read via requireStringArray).
// Deliberately NOT Object.keys(const guide) — that would drag in derived
// non-authored fields (`content`, `category`, `source`). Exported for the
// allowlist↔parser tripwire in __tests__/parse-api-guide.test.ts.
export const GUIDE_ALLOWLIST: ReadonlySet<string> = new Set([
	"kind",
	"domains",
	"shortName",
	"updated",
	"icon",
	"apiHost",
	"verified",
	"docs",
	"organization",
	"description",
	"schemaVersion",
	"gatherAllMax",
	"auth",
	"responseShape",
	"operations",
	"pagination",
]);

// ═══════════════════════════════════════════════════════════════════
// Error helper
// ═══════════════════════════════════════════════════════════════════

// The migration doc for the current schema bump, resolved from this module's
// own location so no hardcoded install path is ever rendered — the doc ships
// in the npm tarball (enforced by ship-manifest.test.ts).
const MIGRATION_DOC_NOTE = `See the migration guide for this schema bump: ${fileURLToPath(new URL("../docs/migration-v1.md", import.meta.url))}.`;

function fail(
	file: string | undefined,
	field: string,
	expected: string,
	found: string,
	extra?: { snippet?: string | undefined; fix?: string | undefined },
): ParseApiGuideResult {
	const error: ParseError = {
		field,
		expected,
		found,
		...(file ? { file } : {}),
		...(extra?.snippet ? { snippet: extra.snippet } : {}),
		...(extra?.fix ? { fix: extra.fix } : {}),
	};
	return { ok: false, error };
}

/** Describe a value's type for `found` strings. */
function describeFound(v: unknown): string {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	if (Array.isArray(v)) return "an array";
	return typeof v;
}

/** Extract a verbatim snippet for a top-level key from the raw frontmatter. */
function snippetFor(frontmatter: string, key: string): string | undefined {
	const lines = frontmatter.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`${key}:`));
	const first = lines[start];
	if (start === -1 || first === undefined) return undefined;
	const out: string[] = [first];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) break;
		// Continue while indented (nested block) or blank.
		if (line.startsWith("  ") || line.startsWith("\t") || line === "") {
			out.push(line);
		} else {
			break;
		}
	}
	return out.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Reserved-char plain-scalar pre-scan
// ═══════════════════════════════════════════════════════════════════

/**
 * Chars that make a plain scalar invalid as a value — yaml's
 * "Plain value cannot start with reserved character" error class. Backtick is
 * the observed footgun (markdown-style `` `field` `` refs pasted into
 * descriptions); `%`/`@`/`,` are the same error class and never legitimate at
 * the start of a value. `|`/`>` (block scalars), `[`/`{` (flow), quotes, and
 * `#` (comments) are all legitimate starts and deliberately NOT flagged.
 */
const RESERVED_PLAIN_START = new Set(["`", "%", "@", ","]);

interface ReservedPlainHit {
	line: number;
	col: number;
	char: string;
}

/**
 * Best-effort one-pass scan for `key: <value>` lines whose plain-scalar value
 * starts with a reserved YAML character. yamlParse throws on the FIRST such
 * value and stops, so a multi-backtick frontmatter needs one save/validate
 * cycle per offender — this lists them all at once. Line/column are reported
 * relative to the frontmatter block (matching yamlParse) and count from the
 * raw line, indentation included. Advisory: only fires on the reserved-char
 * class, which the parser would reject anyway.
 *
 * Block-scalar aware: a `key: >` / `key: |` line opens a folded/literal block
 * whose continuation lines are free-form prose (markdown backticks, `field:
 * value` snippets) — not `key: value` pairs — so they are skipped until a line
 * dedents back to the header's indentation. Without this, a folded
 * `description: >` block containing e.g. `` `all:` `` would be misread as a
 * plain scalar starting with a reserved char.
 */
function scanReservedPlainStarts(fm: string): ReservedPlainHit[] {
	const hits: ReservedPlainHit[] = [];
	const lines = fm.split("\n");
	// Indentation of the currently-open block scalar header line, or -1 when
	// not inside one. Content stays inside until a line dedents to <= this.
	let blockIndent = -1;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trimStart();
		if (blockIndent >= 0) {
			// Blank lines are block content too; only a non-blank dedent ends it.
			if (line === "" || indent > blockIndent) continue;
			blockIndent = -1;
		}
		// Skip blank and comment lines.
		if (line === "" || line.startsWith("#")) continue;
		const m = /^[^:#]+: /.exec(line);
		if (!m) continue;
		const ch = line[m[0].length];
		if (ch === undefined) continue;
		// `>` / `|` value → block scalar opener (also on `- `-prefixed list
		// items like `- description: >`). Enter block mode; its content lines
		// are prose and must not be scanned.
		if (ch === ">" || ch === "|") {
			blockIndent = indent;
			continue;
		}
		// List-item lines (op headers like `- name: …`) are not top-level
		// `key:` pairs — the backtick footgun lives in `description:`-style
		// value lines, which are never `- `-prefixed.
		if (line.startsWith("- ")) continue;
		if (!RESERVED_PLAIN_START.has(ch)) continue;
		hits.push({
			line: i + 1,
			col: raw.length - line.length + m[0].length + 1,
			char: ch,
		});
	}
	return hits;
}

// ═══════════════════════════════════════════════════════════════════
// Field validators
// ═══════════════════════════════════════════════════════════════════

/**
 * Required http/https URL string — returns it back on success, or a
 * ParseApiGuideResult on failure (missing, non-string, empty, unparseable,
 * or a non-http(s) protocol). Callers with an optional field check
 * presence themselves before calling.
 */
function requireHttpUrl(
	value: unknown,
	key: string,
	file: string | undefined,
	fm: string,
	opts?: { protocolFix?: string; invalidFix?: string },
): string | ParseApiGuideResult {
	if (value === undefined) {
		return fail(file, key, "a string", "missing");
	}
	if (typeof value !== "string" || value === "") {
		return fail(file, key, "a string (http/https URL)", describeFound(value), {
			snippet: snippetFor(fm, key),
		});
	}
	try {
		const u = new URL(value);
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			return fail(file, key, "an http or https URL", `protocol "${u.protocol}"`, {
				...(opts?.protocolFix ? { fix: opts.protocolFix } : {}),
			});
		}
	} catch {
		return fail(file, key, "a valid http/https URL", `"${value}"`, {
			...(opts?.invalidFix ? { fix: opts.invalidFix } : {}),
		});
	}
	return value;
}

function requireStringArray(
	m: Record<string, unknown>,
	key: string,
	file: string | undefined,
	fm: string,
	opts?: { missingFix?: string },
): string[] | ParseApiGuideResult {
	const v = m[key];
	if (v === undefined) {
		return fail(file, key, "a list of strings", "missing", {
			...(opts?.missingFix ? { fix: opts.missingFix } : {}),
		});
	}
	if (!Array.isArray(v) || v.length === 0) {
		return fail(file, key, "a non-empty list of strings", describeFound(v), {
			snippet: snippetFor(fm, key),
		});
	}
	for (const item of v) {
		if (typeof item !== "string") {
			return fail(
				file,
				key,
				"a list of strings",
				`contains ${describeFound(item)}`,
				{
					snippet: snippetFor(fm, key),
				},
			);
		}
	}
	return v as string[];
}

// ═══════════════════════════════════════════════════════════════════
// Pagination
// ═══════════════════════════════════════════════════════════════════

function validatePagination(
	raw: unknown,
	fieldPrefix: string,
	file: string | undefined,
): PaginationConfig | ParseApiGuideResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return fail(
			file,
			fieldPrefix,
			"a YAML mapping (style: ..., itemsPath: ...)",
			describeFound(raw),
		);
	}
	const p = raw as Record<string, unknown>;

	const styleRaw = p["style"];
	if (typeof styleRaw !== "string" || !VALID_PAGINATION_STYLE.has(styleRaw)) {
		return fail(
			file,
			`${fieldPrefix}.style`,
			"one of: offset-limit | nextLink | cursor | page | resumptionToken | tokenBag",
			styleRaw === undefined ? "missing" : String(styleRaw),
		);
	}
	const style = styleRaw as PaginationStyle;

	// Per-style allowlist — reject keys not legal for this style (a typo like
	// `itemPath:` or a `cursorPath:` on a nextLink block fails here instead of
	// silently single-paging at runtime). Format mirrors AUTH_ALLOWLISTS.
	const allowlist = PAGINATION_ALLOWLISTS[style];
	const unknownKeys = Object.keys(p).filter((k) => !allowlist.has(k));
	if (unknownKeys.length > 0) {
		const first = unknownKeys[0]!; // guarded by the length check above
		return fail(
			file,
			`${fieldPrefix}.${first}`,
			`a known pagination key for style: ${style} (${[...allowlist].join(", ")})`,
			`unknown key(s): ${unknownKeys.join(", ")}`,
		);
	}

	const itemsPath = p["itemsPath"];
	if (typeof itemsPath !== "string" || itemsPath === "") {
		return fail(
			file,
			`${fieldPrefix}.itemsPath`,
			"a string (JSON path to the items array)",
			itemsPath === undefined ? "missing" : describeFound(itemsPath),
		);
	}

	const cfg: PaginationConfig = { style, itemsPath };

	// Style-specific required fields.
	if (style === "offset-limit" || style === "page") {
		for (const req of ["pageParam", "pageSizeParam"] as const) {
			const v = p[req];
			if (typeof v !== "string" || v === "") {
				return fail(
					file,
					`${fieldPrefix}.${req}`,
					"a string param name",
					v === undefined ? "missing" : describeFound(v),
				);
			}
			Object.assign(cfg, { [req]: v });
		}
		const ps = p["pageSize"];
		if (ps !== undefined) {
			if (typeof ps !== "number" || !Number.isFinite(ps) || ps <= 0) {
				return fail(
					file,
					`${fieldPrefix}.pageSize`,
					"a positive number",
					describeFound(ps),
				);
			}
			cfg.pageSize = ps;
		}
		const base = p["base"];
		if (base !== undefined) {
			if (typeof base !== "number" || !Number.isInteger(base)) {
				return fail(
					file,
					`${fieldPrefix}.base`,
					"a finite integer (the seed value for the page param)",
					describeFound(base),
				);
			}
			cfg.base = base;
		}
	} else if (style === "nextLink") {
		const nlp = p["nextLinkPath"];
		if (typeof nlp !== "string" || nlp === "") {
			return fail(
				file,
				`${fieldPrefix}.nextLinkPath`,
				"a string (JSON path to the next-page URL)",
				nlp === undefined ? "missing" : describeFound(nlp),
			);
		}
		cfg.nextLinkPath = nlp;
	} else if (style === "cursor") {
		for (const req of ["cursorParam", "cursorPath"] as const) {
			const v = p[req];
			if (typeof v !== "string" || v === "") {
				return fail(
					file,
					`${fieldPrefix}.${req}`,
					"a string",
					v === undefined ? "missing" : describeFound(v),
				);
			}
			Object.assign(cfg, { [req]: v });
		}
		// Optional, validated-if-present (both were silently dropped before).
		const cPsp = p["pageSizeParam"];
		if (cPsp !== undefined) {
			if (typeof cPsp !== "string" || cPsp === "") {
				return fail(
					file,
					`${fieldPrefix}.pageSizeParam`,
					"a string param name",
					describeFound(cPsp),
				);
			}
			cfg.pageSizeParam = cPsp;
		}
		const cPs = p["pageSize"];
		if (cPs !== undefined) {
			if (typeof cPs !== "number" || !Number.isFinite(cPs) || cPs <= 0) {
				return fail(
					file,
					`${fieldPrefix}.pageSize`,
					"a positive number",
					describeFound(cPs),
				);
			}
			cfg.pageSize = cPs;
		}
		// pageSize without pageSizeParam is inert (the executor seeds only
		// when both are present) — reject rather than silently no-op.
		if (cPs !== undefined && cPsp === undefined) {
			return fail(
				file,
				`${fieldPrefix}.pageSize`,
				"set alongside pageSizeParam (cursor: the seed only applies with both)",
				describeFound(cPs),
			);
		}
	} else if (style === "resumptionToken") {
		for (const req of ["tokenParam", "tokenPath"] as const) {
			const v = p[req];
			if (typeof v !== "string" || v === "") {
				return fail(
					file,
					`${fieldPrefix}.${req}`,
					"a string",
					v === undefined ? "missing" : describeFound(v),
				);
			}
			Object.assign(cfg, { [req]: v });
		}
	} else if (style === "tokenBag") {
		const cpRaw = p["continuationParams"];
		if (!Array.isArray(cpRaw) || cpRaw.length === 0) {
			return fail(
				file,
				`${fieldPrefix}.continuationParams`,
				"a non-empty list of strings",
				cpRaw === undefined ? "missing" : describeFound(cpRaw),
			);
		}
		for (const item of cpRaw) {
			if (typeof item !== "string" || item === "") {
				return fail(
					file,
					`${fieldPrefix}.continuationParams`,
					"a non-empty list of strings",
					`contains ${describeFound(item)}`,
				);
			}
		}
		cfg.continuationParams = cpRaw as string[];
	}

	// optional totalCountPath (any style) — JSON path to the server's
	// reported total count, surfaced as serverTotal in paginate results.
	const tcp = p["totalCountPath"];
	if (tcp !== undefined) {
		if (typeof tcp !== "string" || tcp === "") {
			return fail(
				file,
				`${fieldPrefix}.totalCountPath`,
				"a non-empty string (JSON path to the server total count)",
				describeFound(tcp),
			);
		}
		cfg.totalCountPath = tcp;
	}

	// optional hasMorePath (any style) — JSON path to a boolean/numeric
	// "more pages" flag; a resolved falsy value stops the walk cleanly.
	const hmp = p["hasMorePath"];
	if (hmp !== undefined) {
		if (typeof hmp !== "string" || hmp === "") {
			return fail(
				file,
				`${fieldPrefix}.hasMorePath`,
				"a non-empty string (JSON path to the has-more flag)",
				describeFound(hmp),
			);
		}
		cfg.hasMorePath = hmp;
	}

	return cfg;
}

// ═══════════════════════════════════════════════════════════════════
// Response shape
// ═══════════════════════════════════════════════════════════════════

function validateResponseShape(
	raw: unknown,
	fieldPrefix: string,
	file: string | undefined,
): ResponseShape | ParseApiGuideResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return fail(
			file,
			fieldPrefix,
			"a YAML mapping (format: ..., charset: ...)",
			describeFound(raw),
		);
	}
	const r = raw as Record<string, unknown>;

	// responseShape allowlist — same closed-schema pass as OP_ALLOWLIST: only
	// format/charset are read, so anything else is a typo that would
	// silently no-op.
	const unknownKeys = Object.keys(r).filter(
		(k) => !RESPONSE_SHAPE_ALLOWLIST.has(k),
	);
	if (unknownKeys.length > 0) {
		const first = unknownKeys[0]!; // guarded by the length check above
		return fail(
			file,
			`${fieldPrefix}.${first}`,
			`a known responseShape key (${[...RESPONSE_SHAPE_ALLOWLIST].join(", ")})`,
			`unknown key(s): ${unknownKeys.join(", ")}`,
			{
				fix: `Remove ${fieldPrefix}.${first} — the responseShape schema is closed.`,
			},
		);
	}

	const formatRaw = r["format"];
	let format: ResponseFormat = "json";
	if (formatRaw !== undefined) {
		if (typeof formatRaw !== "string" || !VALID_FORMAT.has(formatRaw)) {
			return fail(
				file,
				`${fieldPrefix}.format`,
				"one of: json | xml | text",
				String(formatRaw),
			);
		}
		format = formatRaw as ResponseFormat;
	}

	const charsetRaw = r["charset"];
	let charset: ResponseCharset = "utf-8";
	if (charsetRaw !== undefined) {
		if (typeof charsetRaw !== "string" || charsetRaw === "") {
			return fail(
				file,
				`${fieldPrefix}.charset`,
				"a string (utf-8 | IANA charset name)",
				describeFound(charsetRaw),
			);
		}
		charset = charsetRaw;
	}

	return { format, charset };
}

// ═══════════════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate a `Record<string, string>` auth sub-field (headers, secretRefs,
 * secretQueryRefs). Returns the parsed record, or a ParseError when `raw` is
 * absent/null/non-object/an array or any value is not a string.
 */
function parseStringRecord(
	raw: unknown,
	file: string | undefined,
	fm: string,
	field: string,
	expect: string,
): Record<string, string> | ParseApiGuideResult {
	if (
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		Object.values(raw).some((v) => typeof v !== "string")
	) {
		return fail(file, field, expect, describeFound(raw), {
			snippet: snippetFor(fm, "auth"),
		});
	}
	return raw as Record<string, string>;
}

/** `true` when a `parseStringRecord` / validator result is a ParseError. */
function isParseErr<T>(v: T | ParseApiGuideResult): v is ParseApiGuideResult {
	return (
		typeof v === "object" &&
		v !== null &&
		"ok" in v &&
		(v as { ok: unknown }).ok === false
	);
}

function validateAuth(
	raw: unknown,
	file: string | undefined,
	fm: string,
): AuthConfig | ParseApiGuideResult {
	if (raw === undefined) {
		// Default: none. No auth block = none.
		return { kind: "none" };
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return fail(file, "auth", "a YAML mapping (kind: ...)", describeFound(raw), {
			snippet: snippetFor(fm, "auth"),
		});
	}
	const a = raw as Record<string, unknown>;
	const kindRaw = a["kind"];
	if (typeof kindRaw !== "string") {
		return fail(
			file,
			"auth.kind",
			"a string",
			kindRaw === undefined ? "missing" : describeFound(kindRaw),
			{
				fix: "kind is one of: none | static-key | oauth2 — use `kind: none` (public), `kind: static-key` (keyed header), or `kind: oauth2`; or call api-learn({domain, new: true}) for a full skeleton",
			},
		);
	}
	if (!KNOWN_AUTH_KINDS.has(kindRaw)) {
		return fail(
			file,
			"auth.kind",
			"one of: none | static-key | oauth2",
			kindRaw,
			{
				fix: "Use `kind: none` (public), `kind: static-key` (keyed header), or `kind: oauth2`.",
			},
		);
	}
	const kind = kindRaw as AuthKind;
	// Per-variant allowlist — reject keys not legal for this kind (a
	// `tokenUrl` on a static-key block or a `headerPrefixes` on an oauth2
	// block fails here, not silently downstream).
	const allowlist = AUTH_ALLOWLISTS[kind];
	const unknownKeys = Object.keys(a).filter((k) => !allowlist.has(k));
	if (unknownKeys.length > 0) {
		const first = unknownKeys[0]!;
		return fail(
			file,
			`auth.${first}`,
			`a known auth key for kind: ${kind} (${[...allowlist].join(", ")})`,
			`unknown key(s): ${unknownKeys.join(", ")}`,
			{
				snippet: snippetFor(fm, "auth"),
			},
		);
	}

	switch (kind) {
		case "none": {
			let headers: Record<string, string> | undefined;
			if (a["headers"] !== undefined) {
				const hr = parseStringRecord(
					a["headers"],
					file,
					fm,
					"auth.headers",
					"a YAML mapping of string → string",
				);
				if (isParseErr(hr)) return hr;
				headers = hr;
			}
			return { kind: "none", ...(headers === undefined ? {} : { headers }) };
		}
		case "static-key": {
			return validateStaticKeyAuth(a, file, fm);
		}
		case "oauth2": {
			return validateOAuth2Auth(a, file, fm);
		}
		default: {
			const never: never = kind;
			throw new Error(`Unhandled auth kind: ${never}`);
		}
	}
}

/**
 * Parse a nested `Record<string, SecretRef>` (header/form-field name → ref).
 * Each ref is self-contained: `secret` (store name), optional `prefix`, and
 * optional `optional`. The old three-field consistency checks (ref→declared,
 * declared→ref, prefix→ref) are structurally impossible here — there is no
 * `requires`/`optional` roster to diverge from, and `prefix` lives on the ref
 * it applies to.
 */
function parseSecretRefs(
	raw: unknown,
	file: string | undefined,
	fm: string,
	field: string,
): Record<string, SecretRef> | ParseApiGuideResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return fail(
			file,
			field,
			"a YAML mapping of name → { secret: <store name>, prefix?, optional? }",
			describeFound(raw),
			{ snippet: snippetFor(fm, "auth") },
		);
	}
	const out: Record<string, SecretRef> = {};
	for (const [name, v] of Object.entries(raw)) {
		const r = parseSecretRefValue(v, file, fm, `${field}.${name}`);
		if (isParseErr(r)) return r;
		out[name] = r;
	}
	return out;
}

/**
 * Parse a single self-contained `SecretRef` value ({ secret, prefix?,
 * optional? }). Used per-entry by `parseSecretRefs` and directly for the
 * oauth2 named `clientId` / `clientSecret` fields.
 */
function parseSecretRefValue(
	raw: unknown,
	file: string | undefined,
	fm: string,
	field: string,
): SecretRef | ParseApiGuideResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return fail(
			file,
			field,
			"a mapping with secret: <store name>",
			describeFound(raw),
			{ snippet: snippetFor(fm, "auth") },
		);
	}
	const ref = raw as Record<string, unknown>;
	const unknownRefKeys = Object.keys(ref).filter(
		(k) => !["secret", "prefix", "optional"].includes(k),
	);
	if (unknownRefKeys.length > 0) {
		return fail(
			file,
			field,
			"a mapping with only secret/prefix/optional keys",
			`unknown key(s): ${unknownRefKeys.join(", ")}`,
			{ snippet: snippetFor(fm, "auth") },
		);
	}
	const secret = ref["secret"];
	if (typeof secret !== "string" || secret.length === 0) {
		return fail(
			file,
			`${field}.secret`,
			"a non-empty store name",
			describeFound(secret),
			{ snippet: snippetFor(fm, "auth") },
		);
	}
	let prefix: string | undefined;
	if (ref["prefix"] !== undefined) {
		if (
			typeof ref["prefix"] !== "string" ||
			/^\{[a-zA-Z0-9_]+\}$/.test(ref["prefix"])
		) {
			return fail(
				file,
				`${field}.prefix`,
				"a string prefix (empty allowed; not a bare {placeholder})",
				describeFound(ref["prefix"]),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		prefix = ref["prefix"];
	}
	let optional: boolean | undefined;
	if (ref["optional"] !== undefined) {
		if (typeof ref["optional"] !== "boolean") {
			return fail(
				file,
				`${field}.optional`,
				"a boolean",
				describeFound(ref["optional"]),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		optional = ref["optional"];
	}
	return {
		secret,
		...(prefix === undefined ? {} : { prefix }),
		...(optional === undefined ? {} : { optional }),
	};
}

function validateStaticKeyAuth(
	a: Record<string, unknown>,
	file: string | undefined,
	fm: string,
): StaticKeyAuth | ParseApiGuideResult {
	let headers: Record<string, string> | undefined;
	if (a["headers"] !== undefined) {
		const hr = parseStringRecord(
			a["headers"],
			file,
			fm,
			"auth.headers",
			"a YAML mapping of string → string",
		);
		if (isParseErr(hr)) return hr;
		headers = hr;
	}
	let secretRefs: Record<string, SecretRef> | undefined;
	if (a["secretRefs"] !== undefined) {
		const sr = parseSecretRefs(a["secretRefs"], file, fm, "auth.secretRefs");
		if (isParseErr(sr)) return sr;
		secretRefs = sr;
	}
	let secretQueryRefs: Record<string, SecretRef> | undefined;
	if (a["secretQueryRefs"] !== undefined) {
		const qr = parseSecretRefs(
			a["secretQueryRefs"],
			file,
			fm,
			"auth.secretQueryRefs",
		);
		if (isParseErr(qr)) return qr;
		secretQueryRefs = qr;
	}
	let secretPathRefs: Record<string, SecretRef> | undefined;
	if (a["secretPathRefs"] !== undefined) {
		const pr = parseSecretRefs(
			a["secretPathRefs"],
			file,
			fm,
			"auth.secretPathRefs",
		);
		if (isParseErr(pr)) return pr;
		// Path-ref entry checks — fail loud, never silently ignore:
		//  - `prefix` is rejected: path injection is the raw value (the store
		//    value fills {name} verbatim).
		//  - `optional` is rejected (presence, not just `true`): path refs are
		//    required-only — an absent token fails closed in fillPathStrict
		//    before any request, so an optional arm is an error-shaped
		//    pseudostate, not a feature.
		//  - a non-\w name is rejected: fillPathTemplate/extractPathTokens
		//    only match {\w+}, so such a name could never fill — reject with
		//    the grammar message instead of a confusing declared-but-unused
		//    typo error downstream.
		for (const [name, ref] of Object.entries(pr)) {
			if (!/^\w+$/.test(name)) {
				return fail(
					file,
					`auth.secretPathRefs.${name}`,
					"a \\w+ path-token name (the {token} grammar matches \\w+ only)",
					`"${name}"`,
					{
						snippet: snippetFor(fm, "auth"),
						fix: `Rename the ref to an \\w+ name that matches a {token} in some operation's path — e.g. bot_token → {bot_token}.`,
					},
				);
			}
			if (ref.prefix !== undefined) {
				return fail(
					file,
					`auth.secretPathRefs.${name}.prefix`,
					"no prefix key — path injection is the raw secret value",
					`prefix: ${JSON.stringify(ref.prefix)}`,
					{
						snippet: snippetFor(fm, "auth"),
						fix: `Remove prefix from secretPathRefs.${name} — the value fills {${name}} in the path verbatim.`,
					},
				);
			}
			if (ref.optional !== undefined) {
				return fail(
					file,
					`auth.secretPathRefs.${name}.optional`,
					"no optional key — path refs are required-only (an absent path token fails closed before the request)",
					`optional: ${JSON.stringify(ref.optional)}`,
					{
						snippet: snippetFor(fm, "auth"),
						fix: `Remove optional from secretPathRefs.${name} — a path-keyed API has no unauthenticated state.`,
					},
				);
			}
		}
		secretPathRefs = pr;
	}
	const result: StaticKeyAuth = { kind: "static-key" };
	if (headers !== undefined) result.headers = headers;
	if (secretRefs !== undefined) result.secretRefs = secretRefs;
	if (secretQueryRefs !== undefined) result.secretQueryRefs = secretQueryRefs;
	if (secretPathRefs !== undefined) result.secretPathRefs = secretPathRefs;
	return result;
}

function validateOAuth2Auth(
	a: Record<string, unknown>,
	file: string | undefined,
	fm: string,
): OAuth2Auth | ParseApiGuideResult {
	const grant = a["grant"];
	if (!isOAuth2Grant(grant)) {
		return fail(
			file,
			"auth.grant",
			OAUTH2_GRANTS.join(" | "),
			describeFound(grant),
			{
				fix: "grant: client_credentials (server-to-server, no browser) or grant: authorization_code (interactive, PKCE).",
			},
		);
	}
	const tokenUrl = requireHttpUrl(a["tokenUrl"], "auth.tokenUrl", file, fm, {
		protocolFix: "Use https:// as the scheme",
		invalidFix: "Include the scheme, e.g. https://api.example.com/oauth/token",
	});
	if (typeof tokenUrl !== "string") return tokenUrl;
	if (a["clientId"] === undefined) {
		return fail(
			file,
			"auth.clientId",
			"a secret ref ({ secret: <store name> })",
			"missing",
			{
				snippet: snippetFor(fm, "auth"),
				fix: "Add clientId: { secret: client_id } — the store name provisioned via /api secrets <domain>. A shippable guide must not bake in one app's client id.",
			},
		);
	}
	const clientId = parseSecretRefValue(a["clientId"], file, fm, "auth.clientId");
	if (isParseErr(clientId)) return clientId;
	if (clientId.prefix !== undefined || clientId.optional !== undefined) {
		return fail(
			file,
			"auth.clientId",
			"a ref with only { secret } — prefix/optional are meaningless on the client id (it is always required and always used verbatim)",
			JSON.stringify(clientId),
			{
				snippet: snippetFor(fm, "auth"),
				fix: "Remove prefix/optional from clientId — keep clientId: { secret: <store name> }.",
			},
		);
	}
	let clientSecret: SecretRef | undefined;
	if (a["clientSecret"] !== undefined) {
		const cs = parseSecretRefValue(
			a["clientSecret"],
			file,
			fm,
			"auth.clientSecret",
		);
		if (isParseErr(cs)) return cs;
		if (cs.prefix !== undefined) {
			return fail(
				file,
				"auth.clientSecret.prefix",
				"absent — the prefix would be silently ignored (the raw store value is sent as the client secret)",
				JSON.stringify(cs.prefix),
				{
					snippet: snippetFor(fm, "auth"),
					fix: "Remove prefix from clientSecret — keep clientSecret: { secret: <store name> }.",
				},
			);
		}
		if (cs.optional !== undefined && grant === "client_credentials") {
			return fail(
				file,
				"auth.clientSecret.optional",
				"absent for grant: client_credentials (clientSecret is parser-required there; optional can never fire)",
				"optional: true",
				{
					snippet: snippetFor(fm, "auth"),
					fix: "Remove optional from clientSecret — keep clientSecret: { secret: <store name> }.",
				},
			);
		}
		clientSecret = cs;
	}
	let secretRefs: Record<string, SecretRef> | undefined;
	if (a["secretRefs"] !== undefined) {
		const sr = parseSecretRefs(a["secretRefs"], file, fm, "auth.secretRefs");
		if (isParseErr(sr)) return sr;
		secretRefs = sr;
	}
	let scopes: string[] | undefined;
	if (a["scopes"] !== undefined) {
		if (
			!Array.isArray(a["scopes"]) ||
			a["scopes"].some((s) => typeof s !== "string")
		) {
			return fail(
				file,
				"auth.scopes",
				"a list of scope strings",
				describeFound(a["scopes"]),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		scopes = a["scopes"] as string[];
	}
	let paramStyle: OAuth2ParamStyle | undefined;
	if (a["paramStyle"] !== undefined) {
		if (a["paramStyle"] !== "bearer-header" && a["paramStyle"] !== "query") {
			return fail(
				file,
				"auth.paramStyle",
				"bearer-header | query",
				describeFound(a["paramStyle"]),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		paramStyle = a["paramStyle"];
	}
	let tokenEndpointAuthMethod: OAuth2TokenEndpointAuthMethod | undefined;
	if (a["tokenEndpointAuthMethod"] !== undefined) {
		const m = a["tokenEndpointAuthMethod"];
		if (!isOAuth2TokenEndpointAuthMethod(m)) {
			return fail(
				file,
				"auth.tokenEndpointAuthMethod",
				OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS.join(" | "),
				describeFound(m),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		tokenEndpointAuthMethod = m;
	}
	let authorizeUrl: string | undefined;
	if (a["authorizeUrl"] !== undefined) {
		const au = requireHttpUrl(a["authorizeUrl"], "auth.authorizeUrl", file, fm);
		if (typeof au !== "string") return au;
		authorizeUrl = au;
	}
	let revokeUrl: string | undefined;
	if (a["revokeUrl"] !== undefined) {
		const rv = requireHttpUrl(a["revokeUrl"], "auth.revokeUrl", file, fm);
		if (typeof rv !== "string") return rv;
		revokeUrl = rv;
	}

	// Grant invariants — the single shared statement of OAuth2 grant
	// semantics (also enforced by buildSyntheticOAuth2Auth in core/auth.ts
	// for the bootstrap surfaces). Adding a grant or invariant: edit
	// oauth2GrantIssue, then extend both callers' message maps.
	const issue = oauth2GrantIssue({
		grant,
		hasClientSecret: clientSecret !== undefined,
		authorizeUrl,
		tokenEndpointAuthMethod,
	});
	if (issue) {
		switch (issue.code) {
			case "noneWithSecret":
				return fail(
					file,
					"auth.clientSecret",
					"absent when tokenEndpointAuthMethod: none",
					"present",
					{
						snippet: snippetFor(fm, "auth"),
						fix: "Remove clientSecret — tokenEndpointAuthMethod: none sends no client credentials (PKCE public clients have no secret).",
					},
				);
			case "ccRequiresSecret":
				return fail(
					file,
					"auth.clientSecret",
					"a clientSecret ref for grant: client_credentials",
					"missing",
					{
						snippet: snippetFor(fm, "auth"),
						fix: "Add clientSecret: { secret: client_secret } — the store name provisioned via /api secrets <domain>.",
					},
				);
			case "ccRejectsAuthorizeUrl":
				return fail(
					file,
					"auth.authorizeUrl",
					"absent for grant: client_credentials",
					"authorizeUrl present",
					{
						fix: "Remove authorizeUrl — client_credentials is server-to-server with no browser flow.",
					},
				);
			case "acRequiresAuthorizeUrl":
				return fail(
					file,
					"auth.authorizeUrl",
					"a URL for grant: authorization_code",
					"missing",
					{
						fix: "Add authorizeUrl — the provider's authorization endpoint. The redirect URI is the runtime convention http://127.0.0.1/callback (RFC 8252 §7.3); register it on your OAuth app.",
					},
				);
			default: {
				// Compile-time exhaustiveness tripwire: a new OAuth2GrantIssue
				// code must extend this switch (the builder's message map is
				// already forced via its return type). Unreachable at runtime.
				const uncovered: never = issue.code;
				throw new Error(`unhandled OAuth2 grant invariant: ${String(uncovered)}`);
			}
		}
	}

	const result: OAuth2Auth = {
		kind: "oauth2",
		grant,
		tokenUrl,
		clientId,
		...(clientSecret === undefined ? {} : { clientSecret }),
	};
	if (secretRefs !== undefined) result.secretRefs = secretRefs;
	if (scopes !== undefined) result.scopes = scopes;
	if (paramStyle !== undefined) result.paramStyle = paramStyle;
	if (tokenEndpointAuthMethod !== undefined)
		result.tokenEndpointAuthMethod = tokenEndpointAuthMethod;
	if (authorizeUrl !== undefined) result.authorizeUrl = authorizeUrl;
	if (revokeUrl !== undefined) result.revokeUrl = revokeUrl;
	return result;
}

// ═══════════════════════════════════════════════════════════════════
// Operations
// ═══════════════════════════════════════════════════════════════════

function validateOperation(
	raw: unknown,
	index: number,
	file: string | undefined,
	topPagination: PaginationConfig | undefined,
	guideResponseShape: ResponseShape,
	injectedQuerySecretNames: ReadonlySet<string>,
	authKind: string,
): Operation | ParseApiGuideResult {
	const fieldPath = (leaf: string) => `operations[${index}].${leaf}`;

	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return fail(
			file,
			`operations[${index}]`,
			"a YAML mapping",
			describeFound(raw),
		);
	}
	const o = raw as Record<string, unknown>;

	// Op-block allowlist — reject keys not legal for an op (a typo like
	// `errorPaths:` would silently no-op the intended behavior). Format
	// mirrors the pagination per-style allowlist check.
	const unknownKeys = Object.keys(o).filter((k) => !OP_ALLOWLIST.has(k));
	if (unknownKeys.length > 0) {
		const first = unknownKeys[0]!; // guarded by the length check above
		return fail(
			file,
			fieldPath(first),
			`a known op-block key (${[...OP_ALLOWLIST].join(", ")})`,
			`unknown key(s): ${unknownKeys.join(", ")}`,
			{
				fix: `Remove operations[${index}].${first} — the op-block schema is closed.`,
			},
		);
	}

	// name
	const name = o["name"];
	if (typeof name !== "string" || name === "") {
		return fail(
			file,
			fieldPath("name"),
			"a non-empty string",
			name === undefined ? "missing" : describeFound(name),
		);
	}

	// via
	const viaRaw = o["via"];
	if (typeof viaRaw !== "string" || !VALID_VIA.has(viaRaw)) {
		return fail(
			file,
			fieldPath("via"),
			"one of: restGet | paginate",
			viaRaw === undefined ? "missing" : String(viaRaw),
		);
	}
	const via = viaRaw as ExecutorVia;

	// path
	const path = o["path"];
	if (typeof path !== "string") {
		return fail(
			file,
			fieldPath("path"),
			"a string",
			path === undefined ? "missing" : describeFound(path),
		);
	}
	if (!path.startsWith("/")) {
		return fail(
			file,
			fieldPath("path"),
			"a string beginning with /",
			`"${path}" (missing leading /)`,
			{ fix: `Prefix the path with /: /${path}` },
		);
	}
	const pathParams = extractPathTokens(path);

	// accept — any media-type string, default "json"
	const acceptRaw = o["accept"];
	let accept: AcceptType = "json";
	if (acceptRaw !== undefined) {
		if (typeof acceptRaw !== "string") {
			return fail(
				file,
				fieldPath("accept"),
				"a string (media type, or json/xml shorthand)",
				String(acceptRaw),
			);
		}
		accept = acceptRaw;
	}

	// params (query params only)
	const paramsRaw = o["params"];
	const params: Record<string, QueryParamSpec> = {};
	// Docs-only descriptions for path-param tokens (see api-guide-types
	// `Operation.pathParamDocs`): declared as `params.<token>.description`
	// in the recipe, surfaced via api-guide, never sent as a query param.
	const pathParamDocs: Record<string, string> = {};
	if (paramsRaw !== undefined) {
		if (
			paramsRaw === null ||
			typeof paramsRaw !== "object" ||
			Array.isArray(paramsRaw)
		) {
			return fail(
				file,
				fieldPath("params"),
				"a YAML mapping",
				describeFound(paramsRaw),
			);
		}
		for (const [key, spec] of Object.entries(
			paramsRaw as Record<string, unknown>,
		)) {
			// A path-param token may declare only a docs-only `description`
			// (`params.<token>.description`); `required`/`default` are
			// rejected — the value is filled from `{token}` in `path`.
			if (pathParams.includes(key)) {
				if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
					return fail(
						file,
						fieldPath(`params.${key}`),
						"a docs-only mapping (params.<token>.description)",
						describeFound(spec),
						{
							fix: `Write params.${key}.description to document the {${key}} path token — it is filled from {${key}} in the path, not the query string`,
						},
					);
				}
				const s = spec as Record<string, unknown>;
				const onlyDescription = Object.keys(s).length === 1 && "description" in s;
				if (!onlyDescription) {
					return fail(
						file,
						fieldPath(`params.${key}`),
						"a docs-only mapping (params.<token>.description only — path params are inferred from {token} in path)",
						Object.keys(s).length === 0
							? "an empty mapping"
							: `key(s): ${Object.keys(s).join(", ")}`,
						{
							fix: `Keep only params.${key}.description — {${key}} is a path param, filled from {${key}} in the path, not the query string`,
						},
					);
				}
				const desc = s["description"];
				if (typeof desc !== "string") {
					return fail(
						file,
						fieldPath(`params.${key}.description`),
						"a string",
						describeFound(desc),
					);
				}
				pathParamDocs[key] = desc;
				continue;
			}
			if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
				return fail(
					file,
					fieldPath(`params.${key}`),
					"a YAML mapping (required?, default?)",
					describeFound(spec),
				);
			}
			const s = spec as Record<string, unknown>;
			// Unknown-key tripwire — the param-spec schema is closed
			// (required/default/description/listStyle). A typo'd key
			// (`listStyl:`, `requried:`) must not be silently dropped: that's
			// the silent-wrong-wire class. Same philosophy as the
			// pagination/auth allowlists.
			for (const k of Object.keys(s)) {
				if (!PARAM_SPEC_KEYS.has(k)) {
					return fail(
						file,
						fieldPath(`params.${key}.${k}`),
						`one of: ${[...PARAM_SPEC_KEYS].join(" | ")} (unknown param-spec key)`,
						`key "${k}"`,
						{
							fix: `Remove params.${key}.${k} — did you mean one of: ${[...PARAM_SPEC_KEYS].join(", ")}?`,
						},
					);
				}
			}
			const paramSpec: QueryParamSpec = {};
			if (s["required"] !== undefined) {
				if (typeof s["required"] !== "boolean") {
					return fail(
						file,
						fieldPath(`params.${key}.required`),
						"a boolean",
						describeFound(s["required"]),
					);
				}
				paramSpec.required = s["required"];
			}
			if (s["default"] !== undefined) {
				paramSpec.default = s["default"];
			}
			if (s["description"] !== undefined) {
				if (typeof s["description"] !== "string") {
					return fail(
						file,
						fieldPath(`params.${key}.description`),
						"a string",
						describeFound(s["description"]),
					);
				}
				paramSpec.description = s["description"];
			}
			if (s["listStyle"] !== undefined) {
				if (!isListStyle(s["listStyle"])) {
					return fail(
						file,
						fieldPath(`params.${key}.listStyle`),
						`one of: ${LIST_STYLES.join(" | ")}`,
						describeFound(s["listStyle"]),
					);
				}
				paramSpec.listStyle = s["listStyle"];
			}
			// bracket double-dress — the style dresses the wire key with []
			// itself; a declared name already ending in [] would double-dress
			// (id[] + [] → id[][]=).
			if (s["listStyle"] === "bracket" && key.endsWith("[]")) {
				return fail(
					file,
					fieldPath(`params.${key}.listStyle`),
					"a param name that does not already end in [] (bracket adds the dress itself)",
					`"${key}" already ends in [] — the wire key would double-dress (id[][]=)`,
					{
						fix: `Declare the clean name (params.${key.slice(0, -2)}) with listStyle: bracket — the style appends [] to the wire key.`,
					},
				);
			}
			// Array default validation — both arms, same pass. An array default
			// on a non-listStyle param would throw on every call at runtime
			// (arrays are loud errors there once the serializer widening lands);
			// catch the authoring error at parse time. On a listStyle param the
			// elements are validated by the same rules the runtime serializer
			// enforces (scalars only; no comma-bearing element on comma — the
			// joined wire form can't distinguish it from a longer list).
			if (Array.isArray(paramSpec.default)) {
				if (paramSpec.listStyle === undefined) {
					return fail(
						file,
						fieldPath(`params.${key}.default`),
						"a scalar default (an array default requires listStyle)",
						"an array default on a param without listStyle",
						{
							fix: `Declare listStyle: ${LIST_STYLES.join(" | ")} on params.${key}, or use a scalar default — an array value on a non-listStyle param fails on every call.`,
						},
					);
				}
				// Empty array default — the same every-call-throw class as the
				// styleless case above: the runtime serializer rejects [] (the
				// param would be silently dropped), so a defaulted call with no
				// override always fails. Catch it at parse time.
				if (paramSpec.default.length === 0) {
					return fail(
						file,
						fieldPath(`params.${key}.default`),
						"a non-empty array default (an empty array default throws on every defaulted call — the param would be silently dropped)",
						"an empty array default ([])",
						{
							fix: `Omit params.${key}.default entirely, or default to a non-empty array — a caller-supplied [] on a listStyle param still fails per-call by design.`,
						},
					);
				}
				for (const el of paramSpec.default) {
					if (
						el === null ||
						(typeof el !== "string" &&
							typeof el !== "number" &&
							typeof el !== "boolean")
					) {
						return fail(
							file,
							fieldPath(`params.${key}.default`),
							"an array of scalar (string | number | boolean) elements",
							`array contains ${describeFound(el)}`,
						);
					}
					if (
						paramSpec.listStyle === "comma" &&
						typeof el === "string" &&
						el.includes(",")
					) {
						return fail(
							file,
							fieldPath(`params.${key}.default`),
							"comma-free elements (listStyle: comma joins with ',' — a comma-bearing element is indistinguishable from a longer list on the wire)",
							`element "${el}" contains a comma`,
						);
					}
				}
			}
			params[key] = paramSpec;
		}
	}

	// requiresAnyOf — at-least-one-of constraint (one group per op, v1).
	// Parser cross-field checks, same class as the secretQueryRefs collision
	// guard: empty-array reject (check #0, before member inspection),
	// member-exists, path-param reject, no `required: true` overlap, no
	// `default` on a member. A group member that is `required` would defeat
	// the group at runtime; a `default` would fire alongside a caller-supplied
	// sibling. Semantics are at-least-one-of with all supplied members sent
	// (members may combine freely); multi-group lands only as the reserved
	// `requiresAnyOfGroups` sibling key, never a union on this field.
	const requiresAnyOfRaw = o["requiresAnyOf"];
	let requiresAnyOf: string[] | undefined;
	if (requiresAnyOfRaw !== undefined) {
		if (!Array.isArray(requiresAnyOfRaw) || requiresAnyOfRaw.length === 0) {
			return fail(
				file,
				fieldPath("requiresAnyOf"),
				"a non-empty list of param names",
				describeFound(requiresAnyOfRaw),
			);
		}
		for (const member of requiresAnyOfRaw) {
			if (typeof member !== "string" || member === "") {
				return fail(
					file,
					fieldPath("requiresAnyOf"),
					"a non-empty list of param names",
					`contains ${describeFound(member)}`,
				);
			}
			if (pathParams.includes(member)) {
				return fail(
					file,
					fieldPath(`requiresAnyOf.${member}`),
					"a query param name (not a path param)",
					`"${member}" is a path param — path params are always required via {${member}} in path`,
				);
			}
			const spec = params[member];
			if (spec === undefined) {
				return fail(
					file,
					fieldPath(`requiresAnyOf.${member}`),
					"a param name declared in this operation's params",
					`"${member}" is not a declared param`,
				);
			}
			if (spec.required === true) {
				return fail(
					file,
					fieldPath(`requiresAnyOf.${member}`),
					"a param that is not also required: true",
					`"${member}" is required: true`,
					{
						fix: `Remove required: true from params.${member} — it is governed by the requiresAnyOf at-least-one-of group, not per-param required.`,
					},
				);
			}
			if (spec.default !== undefined) {
				return fail(
					file,
					fieldPath(`requiresAnyOf.${member}`),
					"a param that does not also declare a default",
					`"${member}" has a default`,
					{
						fix: `Remove the default from params.${member} — requiresAnyOf members are at-least-one-of peers (all supplied members are sent), so a default would fire alongside a caller-supplied sibling.`,
					},
				);
			}
		}
		requiresAnyOf = requiresAnyOfRaw as string[];
	}

	// dateParams — param name → date format normalization
	const dateParamsRaw = o["dateParams"];
	let dateParams: Record<string, DateParamFormat> | undefined;
	if (dateParamsRaw !== undefined) {
		if (
			dateParamsRaw === null ||
			typeof dateParamsRaw !== "object" ||
			Array.isArray(dateParamsRaw)
		) {
			return fail(
				file,
				fieldPath("dateParams"),
				"a YAML mapping of string param name → date format (iso8601 | yyyymmdd | yyyy-mm-dd)",
				describeFound(dateParamsRaw),
			);
		}
		for (const [k, fmt] of Object.entries(
			dateParamsRaw as Record<string, unknown>,
		)) {
			if (typeof fmt !== "string" || !DATE_PARAM_FORMATS.has(fmt)) {
				return fail(
					file,
					fieldPath(`dateParams.${k}`),
					"one of: iso8601 | yyyymmdd | yyyy-mm-dd",
					describeFound(fmt),
				);
			}
			// Declared-but-dead: date normalization runs only in query assembly
			// (buildQueryParams), while fillPathTemplate fills path tokens raw —
			// a dateParams entry naming a path token can never fire.
			if (pathParams.includes(k)) {
				return fail(
					file,
					fieldPath(`dateParams.${k}`),
					"a query param name (not a path param)",
					`"${k}" is a path param — dateParams normalization runs only in query assembly, and path tokens are filled raw, so the declaration can never fire`,
					{
						fix: `Put the ISO date directly in the path (the real pattern: Polygon.io aggregates {from}/{to}, Frankfurter /{date}) — a future normalization for path tokens would be additive.`,
					},
				);
			}
		}
		dateParams = dateParamsRaw as Record<string, DateParamFormat>;
	}

	// helper (local user-transform) — boolean gate for this domain's helper.ts
	const helper = o["helper"];
	if (helper !== undefined) {
		if (typeof helper !== "boolean") {
			return fail(
				file,
				fieldPath("helper"),
				"true or omitted",
				describeFound(helper),
			);
		}
	}

	// transform (post-response local transform) — boolean gate for this
	// domain's helper.ts named `transform` export (declared, not yet executed).
	const transform = o["transform"];
	if (transform !== undefined) {
		if (typeof transform !== "boolean") {
			return fail(
				file,
				fieldPath("transform"),
				"a boolean (true or omitted)",
				describeFound(transform),
			);
		}
	}

	// passthrough — boolean gate: forward undeclared caller params onto the
	// query string (open param surfaces like Infogami /query.json, CKAN).
	const passthrough = o["passthrough"];
	if (passthrough !== undefined) {
		if (typeof passthrough !== "boolean") {
			return fail(
				file,
				fieldPath("passthrough"),
				"true or omitted",
				describeFound(passthrough),
			);
		}
	}

	// parse (op-level responseShape override)
	const parseRaw = o["parse"];
	let parseOverride: ResponseShape | undefined;
	if (parseRaw !== undefined) {
		const pr = validateResponseShape(parseRaw, fieldPath("parse"), file);
		if (!("format" in pr && typeof pr.format === "string")) {
			return pr as ParseApiGuideResult;
		}
		parseOverride = pr;
	}

	// errorPath — present-only-on-error envelope path. Guards (all parse-time,
	// fail-loud in front of the author):
	//  - non-empty string (wrong type → ParseError)
	//  - tokenizeable — a malformed path would resolve `undefined` at runtime,
	//    i.e. declared-absent → success: the exact confidently-wrong failure
	//    mode this field exists to kill. Parse is the only code that runs
	//    exactly once, in front of the author who can fix it.
	//  - non-empty tokenization — the root path ("$", ".") tokenizes to [] and
	//    would resolve the entire parsed body, which is always defined
	//    post-parseResponse — every call would fail.
	//  - effective shape not text — parseResponse returns the raw body string
	//    for text ops and resolveJsonPath against a string always resolves
	//    undefined (declared-then-dead). Covers an op-level parse override AND
	//    an op without one under a text guide-level responseShape.
	const errorPathRaw = o["errorPath"];
	let errorPath: string | undefined;
	if (errorPathRaw !== undefined) {
		if (typeof errorPathRaw !== "string" || errorPathRaw === "") {
			return fail(
				file,
				fieldPath("errorPath"),
				"a non-empty string JSON path",
				describeFound(errorPathRaw),
			);
		}
		const tokens = tokenizeJsonPath(errorPathRaw);
		if (tokens === null) {
			return fail(
				file,
				fieldPath("errorPath"),
				"a tokenizeable JSON path",
				`"${errorPathRaw}" is malformed (unterminated or non-numeric bracket)`,
				{
					fix: 'Fix the path syntax — e.g. "OAI-PMH.error" or "result[0].message".',
				},
			);
		}
		if (tokens.length === 0) {
			return fail(
				file,
				fieldPath("errorPath"),
				"a JSON path to an error element (not the document root)",
				`"${errorPathRaw}" resolves the entire parsed body — every call would fail`,
			);
		}
		if ((parseOverride ?? guideResponseShape).format === "text") {
			return fail(
				file,
				fieldPath("errorPath"),
				"an op whose effective response shape is not format: text",
				"errorPath can never fire on a text op — parseResponse yields the raw body string, not a resolvable shape",
			);
		}
		errorPath = errorPathRaw;
	}

	// pagination (op-level override)
	const opPaginationRaw = o["pagination"];
	let opPagination: PaginationConfig | undefined;
	if (opPaginationRaw !== undefined) {
		const pr = validatePagination(opPaginationRaw, fieldPath("pagination"), file);
		if (!("style" in pr && typeof pr.style === "string")) {
			return pr as ParseApiGuideResult;
		}
		opPagination = pr;
	}

	// via: paginate requires pagination (top-level or op-level).
	const effectivePagination = opPagination ?? topPagination;
	if (via === "paginate" && effectivePagination === undefined) {
		return fail(
			file,
			fieldPath("pagination"),
			"a pagination block (required when via: paginate)",
			"missing — no top-level pagination and no op-level override",
			{
				fix: "Add a top-level pagination: block or an op-level pagination: override",
			},
		);
	}

	// listStyle collision guard — under keyed supersession, pagination /
	// tokenBag continuation writes REPLACE same-named base params, so a
	// listStyle param colliding with an effective pagination wire name is
	// dead (its listStyle could never reach the wire). Checked against the
	// EFFECTIVE config (op-level ?? guide-level) — a guide-level pageParam
	// collides too. Scoped to via: paginate — the supersession writes only
	// happen in the paginate executor loop, so a restGet op's params are
	// never replaced and no collision is possible there. tokenBag wire names
	// derive via the same wireParamName helper advancePagination uses at
	// runtime — one derivation, two consumers, no drift. Scope: listStyle
	// params only; scalar collisions stay legal (the seeded
	// `page: {default: 0}` + pageParam: page pattern).
	if (via === "paginate" && effectivePagination !== undefined) {
		const wireNames: string[] = [];
		if (effectivePagination.style === "tokenBag") {
			for (const key of effectivePagination.continuationParams ?? []) {
				wireNames.push(wireParamName(key));
			}
		} else {
			if (effectivePagination.pageParam)
				wireNames.push(effectivePagination.pageParam);
			if (effectivePagination.pageSizeParam)
				wireNames.push(effectivePagination.pageSizeParam);
			if (effectivePagination.cursorParam)
				wireNames.push(effectivePagination.cursorParam);
			if (effectivePagination.tokenParam)
				wireNames.push(effectivePagination.tokenParam);
		}
		for (const [key, spec] of Object.entries(params)) {
			if (spec.listStyle === undefined) continue;
			if (wireNames.includes(key)) {
				return fail(
					file,
					fieldPath(`params.${key}.listStyle`),
					"a param name not colliding with this operation's pagination wire params",
					`"${key}" is a pagination wire param (pagination.style: ${effectivePagination.style})`,
					{
						fix: `Rename params.${key} — pagination/tokenBag writes replace same-named base params, so the declared listStyle would never reach the wire.`,
					},
				);
			}
		}
		// Injected query-secret names vs pagination wire names — the paginate
		// URL is built as { ...pageParams, ...secretParams } (core/helpers.ts),
		// so the secret spreads last and overwrites the pagination value on
		// every page request: pagination silently never advances (valid-looking
		// 200s, page one forever). Injected names = static-key secretQueryRefs
		// key names plus oauth2 paramStyle: query's access_token — the same
		// secretQueryParams seam (core/auth.ts), merged last in the same spread.
		// Scoped to via: paginate like the listStyle guard — a restGet op never
		// builds pageParams, so a colliding name is legal there (the guide-level
		// secretQueryRefs-vs-params check must NOT extend to wire names).
		for (const secretName of injectedQuerySecretNames) {
			if (wireNames.includes(secretName)) {
				const isOAuth2 = authKind === "oauth2";
				return fail(
					file,
					isOAuth2 ? "auth.paramStyle" : `auth.secretQueryRefs.${secretName}`,
					"an injected query-secret name not colliding with this operation's pagination wire params",
					`"${secretName}" is a pagination wire param of operation "${name}" (pagination.style: ${effectivePagination.style}) — the injected secret overwrites the pagination value on every page request, so pagination never advances past page one`,
					{
						fix: isOAuth2
							? `Set auth.paramStyle to bearer-header (or rename the wire param in operation "${name}"'s pagination block) — the query-injected access_token is merged after the pagination params and wins every page request.`
							: `Rename the secret ref in auth.secretQueryRefs (or the wire param in operation "${name}"'s pagination block) — the secret is merged after the pagination params and wins every page request.`,
					},
				);
			}
		}
	}

	// listStyle × dateParams — mutually exclusive by design: date params are
	// single-valued (the runtime serializer throws before normalization on any
	// array), so a declared listStyle can never reach the wire. A defaulted
	// listStyle date param would additionally throw on every defaulted call —
	// the same every-call-throw class the array-default guard above exists for.
	if (dateParams !== undefined) {
		for (const key of Object.keys(dateParams)) {
			if (params[key]?.listStyle !== undefined) {
				return fail(
					file,
					fieldPath(`dateParams.${key}`),
					"a param not declaring listStyle (date params are single-valued — listStyle can never apply)",
					`"${key}" declares both listStyle: ${params[key]!.listStyle} and a dateParams entry`,
					{
						fix: `Drop one of the two — keep dateParams.${key} for date normalization, or remove it and declare listStyle on params.${key} if the API truly accepts multi-value dates.`,
					},
				);
			}
		}
	}

	// gatherAllMax (op-level override)
	const opGatherAllMaxRaw = o["gatherAllMax"];
	let opGatherAllMax: number | undefined;
	if (opGatherAllMaxRaw !== undefined) {
		if (
			typeof opGatherAllMaxRaw !== "number" ||
			!Number.isFinite(opGatherAllMaxRaw) ||
			opGatherAllMaxRaw <= 0
		) {
			return fail(
				file,
				fieldPath("gatherAllMax"),
				"a positive number",
				describeFound(opGatherAllMaxRaw),
			);
		}
		opGatherAllMax = opGatherAllMaxRaw;
	}

	const operation: Operation = {
		name,
		via,
		path,
		accept,
		params,
		pathParams,
		...(Object.keys(pathParamDocs).length > 0 ? { pathParamDocs } : {}),
		...(helper === undefined ? {} : { helper }),
		...(transform === undefined ? {} : { transform }),
		...(passthrough === undefined ? {} : { passthrough }),
		...(dateParams === undefined ? {} : { dateParams }),
		...(requiresAnyOf === undefined ? {} : { requiresAnyOf }),
		...(parseOverride ? { parse: parseOverride } : {}),
		...(errorPath === undefined ? {} : { errorPath }),
		...(opPagination ? { pagination: opPagination } : {}),
		...(opGatherAllMax === undefined ? {} : { gatherAllMax: opGatherAllMax }),
	};
	return operation;
}

// ═══════════════════════════════════════════════════════════════════
// parseApiGuide — one parser, two call sites
// ═══════════════════════════════════════════════════════════════════

export function parseApiGuide(
	raw: string,
	opts?: ParseApiGuideOptions,
): ParseApiGuideResult {
	const file = opts?.file;
	const filename = opts?.filename ?? "api-guide";

	const match = raw.match(FRONTMATTER_RE);
	if (!match) {
		// Opening delimiter present → the failure is on the closing side, not
		// a missing frontmatter block. Detect the opener with /^---\r?\n/ (not
		// startsWith("---\n")) so a CRLF-prefixed file is routed here too.
		if (/^---\r?\n/.test(raw)) {
			// A `\n---` after the opener means a closer exists but FRONTMATTER_RE
			// still failed — the closer is malformed (e.g. no trailing newline
			// at EOF). Otherwise there is no closer at all.
			if (/\n---/.test(raw.replace(/^---\r?\n/, ""))) {
				return fail(
					file,
					"frontmatter",
					"a closing --- followed by a newline",
					"closing --- present but malformed (missing trailing newline after it)",
					{
						fix: "Ensure the closing --- is on its own line and followed by a newline before any prose.",
					},
				);
			}
			return fail(
				file,
				"frontmatter",
				"YAML frontmatter delimited by ---",
				"missing closing ---",
				{
					fix: "Close the frontmatter block with a --- line after the YAML.",
				},
			);
		}
		return fail(
			file,
			"frontmatter",
			"YAML frontmatter delimited by ---",
			"no frontmatter found",
			{
				fix: "Begin the file with:\n---\n<yaml>\n---\n<prose>",
			},
		);
	}
	const fm = match[1] ?? "";
	const content = (match[2] ?? "").trim();
	if (fm === "") {
		return fail(
			file,
			"frontmatter",
			"a non-empty YAML mapping",
			"empty frontmatter",
		);
	}

	// One-pass reserved-char pre-scan: yamlParse throws on the FIRST
	// backtick-leading plain scalar and stops, so a multi-offender
	// frontmatter costs one save/validate cycle per line. Scan first and
	// list them all at once. Advisory only — it fires solely on the
	// "Plain value cannot start with reserved character" class, which
	// yamlParse would reject anyway — the parser stays the source of truth.
	const reservedHits = scanReservedPlainStarts(fm);
	if (reservedHits.length > 0) {
		const where = reservedHits
			.map((h) => `line ${h.line}, column ${h.col}: ${h.char}`)
			.join(" ; ");
		return fail(
			file,
			"frontmatter",
			"valid YAML",
			`plain scalar value(s) start with a reserved YAML character — ${where}`,
			{
				snippet: fm,
				fix: 'Quote the value (description: "`the id`") or remove the leading backtick — a plain scalar cannot start with a reserved YAML character.',
			},
		);
	}

	let meta: unknown;
	try {
		meta = yamlParse(fm);
	} catch (e) {
		return fail(
			file,
			"frontmatter",
			"valid YAML",
			e instanceof Error ? e.message : String(e),
			{
				snippet: fm,
			},
		);
	}
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
		return fail(
			file,
			"frontmatter",
			"a YAML mapping (key: value)",
			describeFound(meta),
			{
				snippet: fm,
			},
		);
	}
	const m = meta as Record<string, unknown>;

	// Frontmatter allowlist — reject keys parseApiGuide never reads (a typo'd
	// top-level key would be silently ignored today and hard-fail later once
	// the schema is published). Same closed-schema check as the op-block
	// allowlist; format mirrors the pagination per-style allowlist check.
	const unknownFmKeys = Object.keys(m).filter((k) => !GUIDE_ALLOWLIST.has(k));
	if (unknownFmKeys.length > 0) {
		const first = unknownFmKeys[0]!; // guarded by the length check above
		return fail(
			file,
			first,
			`a known frontmatter key (${[...GUIDE_ALLOWLIST].join(", ")})`,
			`unknown key(s): ${unknownFmKeys.join(", ")}`,
			{
				fix: `Remove ${first} from the frontmatter — the guide schema is closed.`,
			},
		);
	}

	// ── projection slice ──────────────────────────────────────────
	const kindRaw = m["kind"];
	if (kindRaw !== undefined && kindRaw !== "api") {
		return fail(
			file,
			"kind",
			'"api" (or omitted — api-guides are always API kind)',
			kindRaw === "web"
				? '"web" — move this file to a web-guides dir instead'
				: String(kindRaw),
		);
	}
	const kind = "api";

	const domainsRes = requireStringArray(m, "domains", file, fm, {
		missingFix:
			"Call api-learn({domain: '<domain>', new: true}) — it returns a template with `domains` pre-filled",
	});
	if (!Array.isArray(domainsRes)) return domainsRes;
	const domains = domainsRes;

	const icon = typeof m["icon"] === "string" ? (m["icon"] as string) : "📖";
	const shortName =
		typeof m["shortName"] === "string" ? (m["shortName"] as string) : filename;
	const updated =
		typeof m["updated"] === "string" ? (m["updated"] as string) : TODAY();

	// ── recipe slice ──────────────────────────────────────────────
	const apiHostRes = requireHttpUrl(m["apiHost"], "apiHost", file, fm, {
		protocolFix: "Use https:// as the scheme",
		invalidFix: "Include the scheme, e.g. https://api.example.com/v1",
	});
	if (typeof apiHostRes !== "string") return apiHostRes;
	const apiHost = apiHostRes;

	const verified =
		typeof m["verified"] === "string" ? (m["verified"] as string) : TODAY();

	// docs — optional canonical API documentation URL (http/https);
	// omitted when the key is absent.
	let docs: string | undefined;
	const docsRaw = m["docs"];
	if (docsRaw !== undefined) {
		const docsRes = requireHttpUrl(docsRaw, "docs", file, fm);
		if (typeof docsRes !== "string") return docsRes;
		docs = docsRes;
	}

	// organization — optional org identity for catalog grouping +
	// disambiguation. Routing-independent; free-form non-empty string.
	// ponytail: no controlled vocab / uniqueness check — registrable-domain
	// convention bounds collision to cosmetic (routing is on domains:).
	let organization: string | undefined;
	const organizationRaw = m["organization"];
	if (organizationRaw !== undefined) {
		if (typeof organizationRaw !== "string" || organizationRaw === "") {
			return fail(
				file,
				"organization",
				"a non-empty string",
				describeFound(organizationRaw),
				{ snippet: snippetFor(fm, "organization") },
			);
		}
		organization = organizationRaw;
	}

	// description — optional one-line API summary; the primary signal in the
	// multi-guide disambiguation menu. Structural validation only (non-empty,
	// single line). The ≤200-char cap is an api-learn write-path policy, not a
	// parser concern (strict-on-write, lenient-on-read).
	let description: string | undefined;
	const descriptionRaw = m["description"];
	if (descriptionRaw !== undefined) {
		if (typeof descriptionRaw !== "string" || descriptionRaw === "") {
			return fail(
				file,
				"description",
				"a non-empty string",
				describeFound(descriptionRaw),
				{ snippet: snippetFor(fm, "description") },
			);
		}
		if (descriptionRaw.includes("\n")) {
			return fail(
				file,
				"description",
				"a single-line string (no newlines)",
				"contains a newline",
				{
					snippet: snippetFor(fm, "description"),
					fix: "Keep description to one line; put longer prose in the guide body (after ---).",
				},
			);
		}
		description = descriptionRaw;
	}

	// schemaVersion — breaking-change detection, enforced by the hard gate.
	// Stamped on save by api-learn; absent-on-read defaults to 0 (the floor),
	// so an unversioned guide is treated as pre-v1. A valid-integer frontmatter
	// value overrides the floor. A stale value (< current) fails to parse and
	// routes to malformed (the gate below). A malformed (non-integer/negative)
	// value also falls to the floor 0 and is caught by the same gate — one
	// code path, one message.
	let schemaVersion = 0;
	const schemaVersionRaw = m["schemaVersion"];
	if (
		typeof schemaVersionRaw === "number" &&
		Number.isInteger(schemaVersionRaw) &&
		schemaVersionRaw >= 0
	) {
		schemaVersion = schemaVersionRaw;
	}
	if (isStaleSchema(schemaVersion, GUIDE_SCHEMA_VERSION)) {
		return fail(
			file,
			"schemaVersion",
			`>= ${GUIDE_SCHEMA_VERSION} (current)`,
			describeFound(schemaVersionRaw),
			{
				fix:
					`Guide ${file ?? "this guide"} was authored against schema ${schemaVersion}; the current schema is ${GUIDE_SCHEMA_VERSION}. ` +
					`Re-stamp its frontmatter to schemaVersion: ${GUIDE_SCHEMA_VERSION}, hand-fixing any breaking changes listed in the migration doc. ${MIGRATION_DOC_NOTE} ` +
					`Ask your agent to make this fix, then /reload.`,
			},
		);
	}

	let gatherAllMax = GATHER_ALL_MAX_FALLBACK;
	const gatherAllMaxRaw = m["gatherAllMax"];
	if (gatherAllMaxRaw !== undefined) {
		if (
			typeof gatherAllMaxRaw !== "number" ||
			!Number.isFinite(gatherAllMaxRaw) ||
			gatherAllMaxRaw <= 0
		) {
			return fail(
				file,
				"gatherAllMax",
				"a positive integer",
				describeFound(gatherAllMaxRaw),
			);
		}
		gatherAllMax = gatherAllMaxRaw;
	}

	const authRes = validateAuth(m["auth"], file, fm);
	if (!("kind" in authRes)) return authRes as ParseApiGuideResult;
	const auth = authRes;

	let pagination: PaginationConfig | undefined;
	if (m["pagination"] !== undefined) {
		const pr = validatePagination(m["pagination"], "pagination", file);
		if (!("style" in pr)) return pr as ParseApiGuideResult;
		pagination = pr;
	}

	let responseShape: ResponseShape = { format: "json", charset: "utf-8" };
	if (m["responseShape"] !== undefined) {
		const rs = validateResponseShape(m["responseShape"], "responseShape", file);
		if (!("format" in rs)) return rs as ParseApiGuideResult;
		responseShape = rs;
	}

	// operations
	const opsRaw = m["operations"];
	if (opsRaw === undefined) {
		return fail(
			file,
			"operations",
			"a non-empty list of operation mappings",
			"missing",
		);
	}
	if (!Array.isArray(opsRaw) || opsRaw.length === 0) {
		return fail(
			file,
			"operations",
			"a non-empty list of operation mappings",
			describeFound(opsRaw),
			{
				snippet: snippetFor(fm, "operations"),
			},
		);
	}
	const operations: Operation[] = [];
	// Injected query-secret names (the secretQueryParams seam in core/auth.ts):
	// static-key secretQueryRefs key names, plus oauth2 paramStyle: query's
	// access_token. Derived once here (auth is validated above) and passed to
	// every validateOperation for the paginate wire-name collision check.
	const injectedQuerySecretNames: ReadonlySet<string> = new Set([
		...(auth.kind === "static-key" && auth.secretQueryRefs
			? Object.keys(auth.secretQueryRefs)
			: []),
		...(auth.kind === "oauth2" && auth.paramStyle === "query"
			? ["access_token"]
			: []),
	]);
	for (let i = 0; i < opsRaw.length; i++) {
		const opRaw = opsRaw[i];
		if (opRaw === undefined) continue;
		const opRes = validateOperation(
			opRaw,
			i,
			file,
			pagination,
			responseShape,
			injectedQuerySecretNames,
			auth.kind,
		);
		if (!("name" in opRes)) return opRes as ParseApiGuideResult;
		operations.push(opRes);
	}

	// Cross-field: a secretQueryRefs param name must not appear in any
	// operation's `params` map — the agent must never be able to supply a
	// secretly-injected param. Checked here because auth is parsed before
	// operations. `passthrough` ops are NOT rejected (the runtime skips
	// secretQueryRefs keys in buildQueryParams' passthrough branch); only a
	// declared-op colliding with the injected param is a parse error.
	if (auth.kind === "static-key" && auth.secretQueryRefs) {
		for (const paramName of Object.keys(auth.secretQueryRefs)) {
			for (const dOp of operations) {
				if (paramName in dOp.params) {
					return fail(
						file,
						`auth.secretQueryRefs.${paramName}`,
						"a query param name not declared in any operation's params",
						`also a param of operation "${dOp.name}"`,
						{
							fix: `Remove "${paramName}" from operation "${dOp.name}"'s params map — it is code-injected from the secrets store and the agent must not be able to set it.`,
						},
					);
				}
			}
		}
	}

	// Cross-field (oauth2 arm of the same D1 class): on paramStyle: query the
	// injected access_token must not be a declared op param — it spreads last
	// in `{ ...query, ...secretParams }`, so the agent's value would be
	// silently overwritten. Scoped to paramStyle: query — with the default
	// bearer-header the token rides the Authorization header and a legit
	// access_token query param is legal. Paginate ops with access_token as a
	// wire name are already rejected earlier by the wire-name collision check.
	if (auth.kind === "oauth2" && auth.paramStyle === "query") {
		for (const dOp of operations) {
			if ("access_token" in dOp.params) {
				return fail(
					file,
					"auth.paramStyle",
					"an injected query-secret name not declared in any operation's params",
					`also a param of operation "${dOp.name}"`,
					{
						fix: `Remove access_token from operation "${dOp.name}"'s params map — it is code-injected from the token store on paramStyle: query and the agent must not be able to set it.`,
					},
				);
			}
		}
	}

	// Cross-field: secretPathRefs rules. Every path-ref name is a
	// secret-owned path token — the agent must never be able to set it, and
	// it must be load-bearing. Checked after operations (the operative fact
	// is that this runs after BOTH parses):
	//  - a name in any op's `params` map (agent-suppliable). Path-token-keyed
	//    params entries never reach dOp.params (the parser routes them to
	//    pathParamDocs, description-only), so `in dOp.params` is exactly
	//    "agent-suppliable" — a docs-only params.<name>.description entry
	//    stays legal.
	//  - a name in NO op's path as {name} → declared-but-unused (typo).
	//  - a name shared with secretQueryRefs — would inject one secret into
	//    the path and another into the query under the same name.
	if (auth.kind === "static-key" && auth.secretPathRefs) {
		for (const paramName of Object.keys(auth.secretPathRefs)) {
			if (auth.secretQueryRefs && paramName in auth.secretQueryRefs) {
				return fail(
					file,
					`auth.secretPathRefs.${paramName}`,
					"a path-token name not shared with secretQueryRefs",
					`also a secretQueryRefs key`,
					{
						fix: `"${paramName}" is declared in both secretPathRefs and secretQueryRefs — one would fill it in the path and the other in the query under the same name. Rename one.`,
					},
				);
			}
			for (const dOp of operations) {
				if (paramName in dOp.params) {
					return fail(
						file,
						`auth.secretPathRefs.${paramName}`,
						"a path-token name not declared in any operation's params",
						`also a param of operation "${dOp.name}"`,
						{
							fix: `Remove "${paramName}" from operation "${dOp.name}"'s params map — it is code-injected from the secrets store and the agent must not be able to set it. (A docs-only params.${paramName}.description entry is fine.)`,
						},
					);
				}
			}
			const used = operations.some((dOp) => dOp.pathParams.includes(paramName));
			if (!used) {
				return fail(
					file,
					`auth.secretPathRefs.${paramName}`,
					`a path-token name used by at least one operation's path as {${paramName}}`,
					"no operation's path contains {" + paramName + "}",
					{
						fix: `Use {${paramName}} in at least one operation's path, or remove the secretPathRefs entry (declared-but-unused is usually a typo).`,
					},
				);
			}
		}
	}

	const guide: ApiGuide = {
		content,
		updated,
		category: "site",
		source: "user",
		icon,
		shortName,
		domains,
		kind,
		apiHost,
		verified,
		...(docs ? { docs } : {}),
		...(organization ? { organization } : {}),
		...(description ? { description } : {}),
		schemaVersion,
		gatherAllMax,
		auth,
		responseShape,
		operations,
		...(pagination ? { pagination } : {}),
	};
	return { ok: true, guide };
}

// ════════════════════════════════════════════════════════════════════
// Schema-version staleness — the hard gate's predicate
// ════════════════════════════════════════════════════════════════════

/**
 * Pure staleness predicate: a guide is stale when its schemaVersion predates
 * the current schema (a bump may have broken it). A forward-stamped guide
 * (authored against a newer schema than the running host) is NOT stale.
 */
export function isStaleSchema(
	guideSchemaVersion: number,
	currentSchemaVersion: number,
): boolean {
	return guideSchemaVersion < currentSchemaVersion;
}
