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
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Guide } from "./guide-loader.js";
import { extractPathTokens, slug } from "./path-template.js";
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
	type ExecutorVia,
	type AcceptType,
	type QueryParamSpec,
	type LoadedApiGuides,
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
	const keyRe = new RegExp(`^${key}:\\s*.+$`);
	const idx = lines.findIndex((l) => keyRe.test(l));
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

// Strict auth schema: the only keys validateAuth reads. Any other key
// under `auth` is rejected at parse — the parser used to silently drop
// unknowns, so a wrong-but-plausible shape (e.g. `name`/`secret`) saved a
// guide the executor then silently couldn't honor.
const KNOWN_AUTH_KEYS: ReadonlySet<string> = new Set([
	"kind",
	"headers",
	"secretRefs",
	"secretQueryRefs",
	"requires",
	"optional",
	"headerPrefixes",
]);
// Set insertion order — used to render the known-key list in error strings
// (expected + fallback fix) so they can't drift from the set.
const KNOWN_AUTH_KEYS_LIST = [...KNOWN_AUTH_KEYS].join(", ");

// ═══════════════════════════════════════════════════════════════════
// Error helper
// ═══════════════════════════════════════════════════════════════════

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
 */
function scanReservedPlainStarts(fm: string): ReservedPlainHit[] {
	const hits: ReservedPlainHit[] = [];
	const lines = fm.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const line = raw.trimStart();
		// Skip blank, comment, and list-item lines (op headers like
		// `- name: …` — the backtick footgun lives in `description:`-style
		// value lines, which are never `- `-prefixed).
		if (line === "" || line.startsWith("#") || line.startsWith("- ")) continue;
		const m = /^[^:#]+: /.exec(line);
		if (!m) continue;
		const ch = line[m[0].length];
		if (ch === undefined || !RESERVED_PLAIN_START.has(ch)) continue;
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
 * secretQueryRefs, headerPrefixes). Returns the parsed record, or a ParseError
 * when `raw` is absent/null/non-object/an array, or a value fails `valueOk`
 * (default: any string; `headerPrefixes` passes a non-empty check).
 */
function parseStringRecord(
	raw: unknown,
	file: string | undefined,
	fm: string,
	field: string,
	expect: string,
	valueOk: (v: unknown) => boolean = (v) => typeof v === "string",
): Record<string, string> | ParseApiGuideResult {
	if (
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		Object.values(raw).some((v) => !valueOk(v))
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

/** Levenshtein edit distance — spots near-miss auth keys (e.g. `requiers:` →
 * `requires`) so the unknown-key error can say "did you mean X?" instead of a
 * bare rejection. */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = new Array<number>(n + 1);
		cur[0] = i;
		for (let j = 1; j <= n; j++) {
			cur[j] = Math.min(
				prev[j]! + 1,
				cur[j - 1]! + 1,
				prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = cur;
	}
	return prev[n]!;
}

/** Nearest known auth key within edit distance ≤ 2, or undefined. */
function nearestKnownKey(
	key: string,
	known: ReadonlySet<string>,
): string | undefined {
	let best: string | undefined;
	let bestDist = Infinity;
	for (const k of known) {
		const d = editDistance(key, k);
		if (d < bestDist) {
			bestDist = d;
			best = k;
		}
	}
	return bestDist <= 2 ? best : undefined;
}

/**
 * Adaptive fix for an unknown-auth-key rejection: near-miss → "did you mean
 * X?"; the observed wrong shape (`name`/`secret` under static-key) → point at
 * the real secretRefs/requires shape; anything else → list the known keys.
 */
function authUnknownKeyFix(unknownKeys: string[]): string {
	for (const key of unknownKeys) {
		const known = nearestKnownKey(key, KNOWN_AUTH_KEYS);
		if (known !== undefined) {
			return `Unknown auth key "${key}" — did you mean "${known}"?`;
		}
	}
	if (unknownKeys.includes("name") || unknownKeys.includes("secret")) {
		return `The keyed-header shape is auth.secretRefs: { <header>: <secret-name> } with the secret declared in auth.requires (or auth.optional) — replace name/secret with secretRefs + requires.`;
	}
	return `Unknown auth key(s): ${unknownKeys.join(", ")} — known keys: ${KNOWN_AUTH_KEYS_LIST}.`;
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
				fix: "kind is one of: none | static-key — use `kind: none` (public) or `kind: static-key` (keyed header); or call api-learn({domain, new: true}) for a full skeleton",
			},
		);
	}
	if (!KNOWN_AUTH_KINDS.has(kindRaw)) {
		return fail(
			file,
			"auth.kind",
			"one of: none | static-key | oauth2",
			kindRaw,
			{ fix: "Use `kind: none` (public) or `kind: static-key` (keyed header)" },
		);
	}
	// oauth2 is a declared seam, not realized — reject at parse so a recipe
	// can't load an auth mode the transport can't honor.
	if (kindRaw === "oauth2") {
		return fail(file, "auth.kind", "one of: none | static-key", "oauth2", {
			fix: "OAuth2 is not yet implemented. Use kind: none (public) or kind: static-key (keyed header) for now.",
		});
	}
	// Strict auth schema — reject unknown keys. The parser used to
	// silently drop unknown keys (a wrong-but-plausible shape like
	// `name`/`secret` saved a guide the executor then silently couldn't
	// honor). Reject, don't infer: the fix is adaptive (near-miss → "did you
	// mean X?", wrong shape → secretRefs/requires).
	const unknownKeys = Object.keys(a).filter((k) => !KNOWN_AUTH_KEYS.has(k));
	if (unknownKeys.length > 0) {
		const first = unknownKeys[0]!;
		return fail(
			file,
			`auth.${first}`,
			`a known auth key (${KNOWN_AUTH_KEYS_LIST})`,
			`unknown key(s): ${unknownKeys.join(", ")}`,
			{
				snippet: snippetFor(fm, "auth"),
				fix: authUnknownKeyFix(unknownKeys),
			},
		);
	}
	// Parse optional headers (per-kind extra headers, e.g. X-Api-Key for DEMO_KEY).
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

	// static-key reference fields (secretRefs/requires/optional).
	let secretRefs: Record<string, string> | undefined;
	if (a["secretRefs"] !== undefined) {
		const sr = parseStringRecord(
			a["secretRefs"],
			file,
			fm,
			"auth.secretRefs",
			"a YAML mapping of header name → secret name",
		);
		if (isParseErr(sr)) return sr;
		secretRefs = sr;
	}

	// Query-param secrets: maps query param name → secret store name.
	// Same shape + consistency rules as secretRefs; the collision-with-op-`params`
	// rule is enforced in parseApiGuide (auth is parsed before operations).
	let secretQueryRefs: Record<string, string> | undefined;
	if (a["secretQueryRefs"] !== undefined) {
		const qr = parseStringRecord(
			a["secretQueryRefs"],
			file,
			fm,
			"auth.secretQueryRefs",
			"a YAML mapping of query param name → secret name",
		);
		if (isParseErr(qr)) return qr;
		secretQueryRefs = qr;
	}

	let requires: string[] | undefined;
	const reqRaw = a["requires"];
	if (reqRaw !== undefined) {
		if (
			!Array.isArray(reqRaw) ||
			reqRaw.length === 0 ||
			reqRaw.some((v) => typeof v !== "string")
		) {
			return fail(
				file,
				"auth.requires",
				"a non-empty list of secret names",
				describeFound(reqRaw),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		requires = reqRaw as string[];
	}

	let optional: string[] | undefined;
	const optRaw = a["optional"];
	if (optRaw !== undefined) {
		if (
			!Array.isArray(optRaw) ||
			optRaw.length === 0 ||
			optRaw.some((v) => typeof v !== "string")
		) {
			return fail(
				file,
				"auth.optional",
				"a non-empty list of secret names",
				describeFound(optRaw),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		optional = optRaw as string[];
	}

	// static-key header prefixes: header name → non-empty prefix string
	// prepended to the resolved secret value. Same mapping shape as secretRefs;
	// every key must also be a secretRefs header (a prefix for a non-secret
	// header is a mistake).
	let headerPrefixes: Record<string, string> | undefined;
	if (a["headerPrefixes"] !== undefined) {
		const hp = parseStringRecord(
			a["headerPrefixes"],
			file,
			fm,
			"auth.headerPrefixes",
			"a YAML mapping of header name → non-empty prefix string",
			(v) =>
				typeof v === "string" && v.length > 0 && !/^\{[a-zA-Z0-9_]+\}$/.test(v),
		);
		if (isParseErr(hp)) return hp;
		headerPrefixes = hp;
	}

	// Fail-closed consistency rules.
	if (
		kindRaw === "none" &&
		(secretRefs || secretQueryRefs || requires || optional || headerPrefixes)
	) {
		return fail(
			file,
			"auth.secretRefs",
			"absent when auth.kind is none",
			"secretRefs/secretQueryRefs/requires/optional with kind: none",
			{
				fix: "Use auth.kind: static-key to reference stored secrets, or remove the auth fields for a public API.",
			},
		);
	}
	if (requires || optional || secretRefs || secretQueryRefs) {
		const declared = new Set([...(requires ?? []), ...(optional ?? [])]);
		const refNames = new Set([
			...Object.values(secretRefs ?? {}),
			...Object.values(secretQueryRefs ?? {}),
		]);
		const checkRefs = (
			refs: Record<string, string>,
			field: string,
		): ParseApiGuideResult | null => {
			for (const outName of Object.keys(refs)) {
				const secretName = refs[outName]!;
				if (!declared.has(secretName)) {
					return fail(
						file,
						`${field}.${outName}`,
						"a secret name declared in auth.requires or auth.optional",
						`"${secretName}" is not in requires/optional`,
						{
							fix: `Add "${secretName}" to auth.requires or auth.optional (or fix the reference).`,
						},
					);
				}
			}
			return null;
		};
		const r1 = checkRefs(secretRefs ?? {}, "auth.secretRefs");
		if (r1) return r1;
		const r2 = checkRefs(secretQueryRefs ?? {}, "auth.secretQueryRefs");
		if (r2) return r2;
		const both = (requires ?? []).filter((n) => (optional ?? []).includes(n));
		if (both.length > 0) {
			return fail(
				file,
				"auth.requires",
				"secret names not duplicated across requires and optional",
				`in both: ${both.join(", ")}`,
				{
					fix: `Move "${both[0]}" to either requires or optional, not both.`,
				},
			);
		}
		const checkDeclared = (
			names: string[],
			field: string,
		): ParseApiGuideResult | null => {
			for (const name of names) {
				if (!refNames.has(name)) {
					return fail(
						file,
						field,
						"a secret name referenced by auth.secretRefs or auth.secretQueryRefs",
						`"${name}" is declared here but not referenced by any header/query ref`,
						{
							fix: `Reference "${name}" from auth.secretRefs or auth.secretQueryRefs, or remove it from ${field}.`,
						},
					);
				}
			}
			return null;
		};
		const r3 = checkDeclared(requires ?? [], "auth.requires");
		if (r3) return r3;
		const r4 = checkDeclared(optional ?? [], "auth.optional");
		if (r4) return r4;
	}
	// Every headerPrefixes key must target a secret-injected header; a prefix
	// for a header that isn't in secretRefs is a mistake. Checked outside the
	// secretRefs/requires/optional block so a headerPrefixes-only guide fails
	// too (the prefix would otherwise be dead at fetch time silently).
	if (headerPrefixes) {
		for (const headerName of Object.keys(headerPrefixes)) {
			if (!secretRefs || !(headerName in secretRefs)) {
				return fail(
					file,
					`auth.headerPrefixes.${headerName}`,
					"a header name present in auth.secretRefs",
					`"${headerName}" is not a secret-injected header`,
					{
						fix: `Add "${headerName}" to auth.secretRefs (or remove the prefix).`,
					},
				);
			}
		}
	}

	const result: AuthConfig = { kind: kindRaw as AuthKind };
	if (headers !== undefined) result.headers = headers;
	if (secretRefs !== undefined) result.secretRefs = secretRefs;
	if (headerPrefixes !== undefined) result.headerPrefixes = headerPrefixes;
	if (secretQueryRefs !== undefined) result.secretQueryRefs = secretQueryRefs;
	if (requires !== undefined) result.requires = requires;
	if (optional !== undefined) result.optional = optional;
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
			params[key] = paramSpec;
		}
	}

	// requiresAnyOf — at-least-one-of constraint (one group per op, v1).
	// Parser cross-field checks, same class as the secretQueryRefs collision
	// guard: empty-array reject (check #0, before member inspection),
	// member-exists, path-param reject, no `required: true` overlap, no
	// `default` on a member. A group member that is `required` would defeat
	// the group at runtime; a `default` would fire alongside a caller-supplied
	// sibling (the members are mutually exclusive peers).
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
						fix: `Remove required: true from params.${member} — it is governed by the requiresAnyOf group, not per-param required.`,
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
						fix: `Remove the default from params.${member} — requiresAnyOf members are mutually exclusive peers, so a default would fire alongside a caller-supplied sibling.`,
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

	// schemaVersion — breaking-change detection (design: "schemaVersion is
	// detection, not enforcement"). Stamped on save by api-learn; absent-on-
	// read defaults to 0 (the floor), so an unversioned guide flags as
	// potentially stale after any schema bump rather than silently inheriting
	// the new current. A valid-integer frontmatter value overrides the floor.
	// A stale value (< current) warns non-blockingly in the api-guide catalog/
	// detail and on api-fetch; never gates. A malformed (non-integer/negative)
	// value falls back to 0 and never rejects a guide.
	let schemaVersion = 0;
	const schemaVersionRaw = m["schemaVersion"];
	if (
		typeof schemaVersionRaw === "number" &&
		Number.isInteger(schemaVersionRaw) &&
		schemaVersionRaw >= 0
	) {
		schemaVersion = schemaVersionRaw;
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
	for (let i = 0; i < opsRaw.length; i++) {
		const opRaw = opsRaw[i];
		if (opRaw === undefined) continue;
		const opRes = validateOperation(opRaw, i, file, pagination);
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

// ═══════════════════════════════════════════════════════════════════
// projectToGuide — strips recipe fields, keeps presentation + kind
// ═══════════════════════════════════════════════════════════════════

export function projectToGuide(guide: ApiGuide): Guide {
	const projection: Guide = {
		content: guide.content,
		updated: guide.updated,
		category: guide.category,
		source: guide.source,
		icon: guide.icon,
		shortName: guide.shortName,
		kind: guide.kind,
		...(guide.domains ? { domains: guide.domains } : {}),
	};
	return projection;
}

// ═══════════════════════════════════════════════════════════════════
// Directory loader — one malformed guide doesn't block the store.
//
// Loads from per-guide subdirectories: <dir>/<slug(shortName)>/guide.md.
// The folder name must equal slug(shortName) — a divergent folder routes to
// malformed (enforced), so the active set holds at most one guide per
// shortName. Flat top-level .md files are not loaded.
// ═══════════════════════════════════════════════════════════════════

/**
 * Push a malformed guide and warn about it. One helper owns both the catalog
 * entry and the load-time console.warn, so every malformed guide — parse
 * failure, illegal shortName, divergent folder — surfaces the same signal
 * (and its actionable `fix` when present) instead of being silently
 * quarantined. Fires once per cached scan, same channel as the duplicate-
 * shortName check.
 */
function pushMalformed(
	result: LoadedApiGuides,
	file: string,
	filename: string,
	error: ParseError,
): void {
	result.malformed.push({ file, filename, error });
	console.warn(
		`⚠ Malformed guide '${filename}': ${error.field} — expected ${error.expected}; found ${error.found}.` +
			(error.fix ? ` ${error.fix}` : ""),
	);
}

export function loadApiGuidesFromDir(dir: string): LoadedApiGuides {
	const result: LoadedApiGuides = { guides: {}, malformed: [] };
	if (!existsSync(dir)) return result;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return result;
	}
	// Scan-local duplicate-shortName tracker (migration-window check only).
	// shortName → the first folder that declared it, so the duplicate warning
	// can name both folders. Not a field on LoadedApiGuides.
	const seenShortNames = new Map<string, string>();
	for (const entry of entries) {
		const entryPath = join(dir, entry);
		try {
			if (!statSync(entryPath).isDirectory()) continue;
		} catch {
			continue;
		}
		const guidePath = join(entryPath, "guide.md");
		try {
			if (!statSync(guidePath).isFile()) continue;
		} catch {
			continue;
		}
		const name = entry; // folder name = slug(shortName) in steady state
		let raw: string;
		try {
			raw = readFileSync(guidePath, "utf-8");
		} catch {
			continue;
		}
		const parsed = parseApiGuide(raw, {
			file: guidePath,
			filename: name,
		});
		if (parsed.ok) {
			const guide = parsed.guide;
			// Illegal-shortName + divergence checks (permanent). One try/catch
			// owns the slug() call: a throw (empty or all-symbol shortName) is
			// routed to malformed, never escaped. This wrapping lives in the
			// permanent checks so the loader stays safe after the 0.5.0
			// duplicate-check deletion.
			let slugged: string;
			try {
				slugged = slug(guide.shortName);
			} catch {
				pushMalformed(result, guidePath, name, {
					field: "shortName",
					expected: "a shortName that slugs to a non-empty safe directory name",
					found: `"${guide.shortName}"`,
					fix: "Set a valid shortName (lowercase letters, digits, and '-') in the guide's frontmatter.",
				});
				continue;
			}
			// TODO(0.5.0): remove — save-time slug() makes duplicate shortNames
			// unreachable once all folders are migrated. Tracked on guides that
			// pass the slug (before divergence routing) so the migration window —
			// two divergent folders sharing a valid shortName — still surfaces a
			// clear "delete one" warning instead of two opaque malformed entries.
			const first = seenShortNames.get(guide.shortName);
			if (first === undefined) {
				seenShortNames.set(guide.shortName, entry);
			} else {
				console.warn(
					`⚠ Duplicate shortName '${guide.shortName}' in folders '${first}' and '${entry}'. ` +
						`Delete one: /api delete <one>.`,
				);
			}
			// Divergence check (permanent) — ENFORCED, not advisory: the folder
			// name must equal slug(shortName); the coupling IS the identity. A
			// divergent guide routes to malformed (never loads), so the active
			// set structurally holds at most one guide per shortName.
			if (entry !== slugged) {
				pushMalformed(result, guidePath, name, {
					field: "shortName",
					expected: `a folder named slug(shortName) ('${slugged}')`,
					found: `folder '${entry}'`,
					fix: `Rename the folder to '${slugged}': mv ${entryPath} ${join(dir, slugged)}, then /reload.`,
				});
				continue;
			}
			result.guides[entry] = guide;
		} else {
			pushMalformed(result, guidePath, name, parsed.error);
		}
	}
	return result;
}

// ════════════════════════════════════════════════════════════════════
// Schema-version staleness — detection, never a gate
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

/**
 * Non-blocking stale-schema warning line for a guide, or undefined when the
 * guide is current. Peer of the `⚠ malformed` catalog line — detection,
 * never a gate (the guide still loads and runs). `current` defaults to
 * GUIDE_SCHEMA_VERSION; tests pass a bumped value to force staleness.
 */
export function staleSchemaLine(
	guide: ApiGuide,
	current: number = GUIDE_SCHEMA_VERSION,
): string | undefined {
	const v = guide.schemaVersion ?? 0;
	if (!isStaleSchema(v, current)) return undefined;
	return `  ⚠ schemaVersion ${v} < current ${current} — guide may need updating`;
}

// ════════════════════════════════════════════════════════════════════
// Disambiguation helpers — shared by the api-guide menu and the
// api-fetch ambiguous-operation error. One rendering of the per-guide
// listing so the two surfaces stay visually consistent.
// ════════════════════════════════════════════════════════════════════

/**
 * Truncated op-name summary for disambiguation surfaces:
 * "N ops: a, b, c, d, e, +K more" (first 5 names, then the remaining count).
 * A 50-op guide must not dump 50 names into context — the menu exists to
 * help pick a guide cheaply; the full op list is one api-guide call away.
 */
function formatOpSummary(ops: { name: string }[]): string {
	const names = ops.map((o) => o.name);
	const count = names.length;
	const head = names.slice(0, 5);
	const remaining = count - head.length;
	const tail = remaining > 0 ? `, +${remaining} more` : "";
	return `${count} ops: ${head.join(", ")}${tail}`;
}

/**
 * Per-guide listing lines for a disambiguation surface (the api-guide
 * multi-guide menu and the api-fetch ambiguous-op error). Each entry:
 * `icon shortName` [+ ` — description` when present] then the truncated
 * op-name list. When `description:` is absent the line falls back to
 * shortName + op names only (the status-quo shape), so un-backfilled
 * guides render consistently with those that have a one-line summary.
 */
export function formatGuideListings(
	entries: { guide: ApiGuide }[],
	current: number = GUIDE_SCHEMA_VERSION,
): string {
	const lines: string[] = [];
	for (const { guide } of entries) {
		lines.push(
			`  ${guide.icon} ${guide.shortName}` +
				(guide.description ? ` — ${guide.description}` : ""),
		);
		lines.push(`    ${formatOpSummary(guide.operations)}`);
		const stale = staleSchemaLine(guide, current);
		if (stale) lines.push(stale);
	}
	return lines.join("\n");
}

/**
 * Resolve a guide by shortName across a domain's matches (exact,
 * case-insensitive). Shared by api-guide, api-learn's fetch-recipe, and
 * /api verify — three call sites, one resolution rule (a drifted copy would
 * ship a known second bug). Returns a structured outcome; each caller renders
 * its own message (tool result vs command notify).
 */
export function selectGuideByShortName(
	matches: { guide: ApiGuide; dirName: string }[],
	selector: string,
):
	| { ok: true; guide: ApiGuide; dirName: string }
	| { ok: false; reason: "no_match"; valid: string[] }
	| { ok: false; reason: "ambiguous"; directories: string[] } {
	const lc = selector.toLowerCase();
	const sel = matches.filter((m) => m.guide.shortName.toLowerCase() === lc);
	if (sel.length === 0) {
		return {
			ok: false,
			reason: "no_match",
			valid: matches.map((m) => m.guide.shortName),
		};
	}
	if (sel.length > 1) {
		return {
			ok: false,
			reason: "ambiguous",
			directories: sel.map((s) => s.dirName),
		};
	}
	return { ok: true, guide: sel[0]!.guide, dirName: sel[0]!.dirName };
}

/**
 * Render the no-match / ambiguous error text for a failed
 * `selectGuideByShortName` result. `callToAction` is the trailing
 * "how to see the menu" sentence — it differs per surface (tool vs
 * command), so callers pass their own.
 */
export function shortNameErrorText(
	sel: Extract<ReturnType<typeof selectGuideByShortName>, { ok: false }>,
	domain: string,
	selector: string,
	callToAction: string,
): string {
	if (sel.reason === "no_match") {
		return (
			`No guide named '${selector}' for '${domain}'. ` +
			`Available guides: ${sel.valid.join(", ")}. ` +
			callToAction
		);
	}
	return (
		`Ambiguous guide '${selector}' for '${domain}' — ` +
		`${sel.directories.length} guides share shortName '${selector}' ` +
		`(directories: ${sel.directories.join(", ")}). Rename one guide's shortName to ` +
		`disambiguate. ` +
		callToAction
	);
}

// ════════════════════════════════════════════════════════════════════
// Catalog rendering — healthy + ⚠ malformed together
//
// Base catalog is collapsed by `organization:`: one line per org with its
// guide count and domain set. Guides without `organization:` fall back to
// the per-guide line, so the un-backfilled corpus renders unchanged (no
// forced migration). Op counts live on the per-domain disambiguation menu
// (api-guide {domain}), where they're useful for picking a guide — not
// here, where they'd bloat context for orgs with many guides.
// ════════════════════════════════════════════════════════════════════

export function formatApiGuideCatalog(
	loaded: LoadedApiGuides,
	current: number = GUIDE_SCHEMA_VERSION,
): string {
	const lines: string[] = ["API guides:"];

	// Org-grouped rows preserve first-appearance order; guides without
	// organization fall back to the per-guide line (no forced migration).
	const orgRows: { org: string; guides: ApiGuide[] }[] = [];
	const orgIndex = new Map<string, number>();
	const orgless: { name: string; guide: ApiGuide }[] = [];
	for (const [name, guide] of Object.entries(loaded.guides)) {
		if (guide.organization) {
			const idx = orgIndex.get(guide.organization);
			if (idx === undefined) {
				orgIndex.set(guide.organization, orgRows.length);
				orgRows.push({ org: guide.organization, guides: [guide] });
			} else {
				orgRows[idx]!.guides.push(guide);
			}
		} else {
			orgless.push({ name, guide });
		}
	}

	for (const row of orgRows) {
		const domains = new Set<string>();
		for (const g of row.guides) {
			for (const d of g.domains ?? []) domains.add(d);
		}
		const domList = domains.size > 0 ? [...domains].join(", ") : "—";
		const n = row.guides.length;
		// Collapsed org row: a trailing ⚠ glyph when ANY guide in it is stale
		// (hint only — the per-guide ⚠ line lives on the menu / detail view).
		const stale = row.guides.some((g) =>
			isStaleSchema(g.schemaVersion ?? 0, current),
		);
		lines.push(
			`  🏛️ ${row.org} — ${n} guide${n > 1 ? "s" : ""} (${domList})${stale ? " ⚠" : ""}`,
		);
	}
	for (const { name, guide } of orgless) {
		const domains =
			guide.domains && guide.domains.length > 0 ? guide.domains.join(", ") : name;
		lines.push(
			`  ${guide.icon} ${guide.shortName} — ${domains} (verified ${guide.verified}, ${guide.operations.length} ops)`,
		);
		const stale = staleSchemaLine(guide, current);
		if (stale) lines.push(stale);
	}
	for (const mal of loaded.malformed) {
		lines.push(
			`  ⚠ malformed — ${mal.filename}: ${mal.error.field} — expected ${mal.error.expected}; found ${mal.error.found}`,
		);
		// Actionable advice on its own line, matching api-fetch/api-learn's
		// `Fix:` convention — multi-line fixes (e.g. the frontmatter template)
		// render naturally instead of being inlined into the summary line.
		if (mal.error.fix) lines.push(`    fix: ${mal.error.fix}`);
	}
	if (Object.keys(loaded.guides).length === 0 && loaded.malformed.length === 0) {
		lines.push(
			"  (no guides — call api-learn({domain, recipeFile}) to author one)",
		);
	}
	lines.push("");
	lines.push(
		'Call api-guide({domain: "<name>"}) for detail. Multiple guides for a domain show a disambiguation menu.',
	);
	return lines.join("\n");
}
