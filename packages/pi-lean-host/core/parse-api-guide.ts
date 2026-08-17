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
import { extractPathTokens } from "./path-template.js";
import {
	GATHER_ALL_MAX_FALLBACK,
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
): string[] | ParseApiGuideResult {
	const v = m[key];
	if (v === undefined) {
		return fail(file, key, "a list of strings", "missing");
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
	// Parse optional headers (per-kind extra headers, e.g. X-Api-Key for DEMO_KEY).
	let headers: Record<string, string> | undefined;
	const headersRaw = a["headers"];
	if (headersRaw !== undefined) {
		if (
			headersRaw === null ||
			typeof headersRaw !== "object" ||
			Array.isArray(headersRaw) ||
			Object.values(headersRaw).some((v) => typeof v !== "string")
		) {
			return fail(
				file,
				"auth.headers",
				"a YAML mapping of string → string",
				describeFound(headersRaw),
			);
		}
		headers = headersRaw as Record<string, string>;
	}

	// static-key reference fields (secretRefs/requires/optional).
	let secretRefs: Record<string, string> | undefined;
	const refsRaw = a["secretRefs"];
	if (refsRaw !== undefined) {
		if (
			refsRaw === null ||
			typeof refsRaw !== "object" ||
			Array.isArray(refsRaw) ||
			Object.values(refsRaw).some((v) => typeof v !== "string")
		) {
			return fail(
				file,
				"auth.secretRefs",
				"a YAML mapping of header name → secret name",
				describeFound(refsRaw),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		secretRefs = refsRaw as Record<string, string>;
	}

	// Query-param secrets: maps query param name → secret store name.
	// Same shape + consistency rules as secretRefs; the collision-with-op-`params`
	// rule is enforced in parseApiGuide (auth is parsed before operations).
	let secretQueryRefs: Record<string, string> | undefined;
	const sqrRaw = a["secretQueryRefs"];
	if (sqrRaw !== undefined) {
		if (
			sqrRaw === null ||
			typeof sqrRaw !== "object" ||
			Array.isArray(sqrRaw) ||
			Object.values(sqrRaw).some((v) => typeof v !== "string")
		) {
			return fail(
				file,
				"auth.secretQueryRefs",
				"a YAML mapping of query param name → secret name",
				describeFound(sqrRaw),
				{ snippet: snippetFor(fm, "auth") },
			);
		}
		secretQueryRefs = sqrRaw as Record<string, string>;
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

	// Fail-closed consistency rules.
	if (
		kindRaw === "none" &&
		(secretRefs || secretQueryRefs || requires || optional)
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

	const result: AuthConfig = { kind: kindRaw as AuthKind };
	if (headers !== undefined) result.headers = headers;
	if (secretRefs !== undefined) result.secretRefs = secretRefs;
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

	const domainsRes = requireStringArray(m, "domains", file, fm);
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
		invalidFix: "Include the scheme, e.g. https://apidatos.boe.es/v1",
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

	// schemaVersion — metadata-only attribution (design: "schemaVersion is
	// attribution, not enforcement"). Read from frontmatter, surfaced on the
	// parsed guide when present, left `undefined` when absent. Never gates,
	// warns, or alters parse. A malformed (non-integer/negative) value is
	// tolerated and ignored — it must never reject a guide.
	let schemaVersion: number | undefined;
	const schemaVersionRaw = m["schemaVersion"];
	if (schemaVersionRaw !== undefined) {
		if (
			typeof schemaVersionRaw === "number" &&
			Number.isInteger(schemaVersionRaw) &&
			schemaVersionRaw >= 0
		) {
			schemaVersion = schemaVersionRaw;
		}
		// else: tolerated + ignored — metadata stays silent on malformed input.
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
		...(schemaVersion === undefined ? {} : { schemaVersion }),
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
// Loads from per-domain subdirectories: <dir>/<domain>/guide.md.
// Flat top-level .md files are no longer loaded (pre-ship break;
// no production user guides exist before this change).
// ═══════════════════════════════════════════════════════════════════

export function loadApiGuidesFromDir(dir: string): LoadedApiGuides {
	const result: LoadedApiGuides = { guides: {}, malformed: [] };
	if (!existsSync(dir)) return result;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return result;
	}
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
		const name = entry; // domain name = subdir name
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
			result.guides[name] = parsed.guide;
		} else {
			result.malformed.push({
				file: guidePath,
				filename: name,
				error: parsed.error,
			});
		}
	}
	return result;
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
	entries: { guide: ApiGuide; dirName: string }[],
): string {
	const lines: string[] = [];
	for (const { guide } of entries) {
		lines.push(
			`  ${guide.icon} ${guide.shortName}` +
				(guide.description ? ` — ${guide.description}` : ""),
		);
		lines.push(`    ${formatOpSummary(guide.operations)}`);
	}
	return lines.join("\n");
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

export function formatApiGuideCatalog(loaded: LoadedApiGuides): string {
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
		lines.push(`  🏛️ ${row.org} — ${n} guide${n > 1 ? "s" : ""} (${domList})`);
	}
	for (const { name, guide } of orgless) {
		const domains =
			guide.domains && guide.domains.length > 0 ? guide.domains.join(", ") : name;
		lines.push(
			`  ${guide.icon} ${guide.shortName} — ${domains} (verified ${guide.verified}, ${guide.operations.length} ops)`,
		);
	}
	for (const mal of loaded.malformed) {
		lines.push(
			`  ⚠ malformed — ${mal.filename}: ${mal.error.field} — expected ${mal.error.expected}; found ${mal.error.found}`,
		);
	}
	if (Object.keys(loaded.guides).length === 0 && loaded.malformed.length === 0) {
		lines.push("  (no guides — call api-learn({domain, recipe}) to author one)");
	}
	lines.push("");
	lines.push(
		'Call api-guide({domain: "<name>"}) for detail. Multiple guides for a domain show a disambiguation menu.',
	);
	return lines.join("\n");
}
