/**
 * api-probe tool definition.
 *
 * Shape-discovery for the authoring loop: fetch an exploratory path against a
 * domain's apiHost, summarize the JSON shape, suggest `via` / `itemsPath`,
 * echo a representative record id, and emit a draft YAML op block to paste
 * into `guide.md`. The author confirms — it never writes the guide.
 *
 * Pre-guide: call it with a bare URL + templated path. For an endpoint that
 * already has a guide, get the `apiHost` from `api-guide({domain})` first.
 *
 * The suggestions (via/itemsPath/draft) are advisory — the operation must
 * still be traceable to a real endpoint ("cite the source, don't invent
 * endpoints"). This tool surfaces evidence, not authority.
 *
 * Reuses the same `transport.ts` pipeline as api-fetch (UA, charset, 429
 * retry, ETag cache) — the sanctioned way to reach even WAF'd hosts.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { fetchUrl, redactSecretParams } from "../core/transport.js";
import {
	extractPathTokens,
	fillPathTemplate,
	joinUrl,
} from "../core/path-template.js";
import {
	resolveSecretHeaders,
	resolveSecretQueryParams,
	scrubSecretValues,
} from "../core/auth.js";
import {
	listDomains,
	listNames,
	provisionedDomainsSuffix,
} from "../core/secrets-store.js";
import { findGuidesByDomain } from "../core/guide-store.js";
import { GUIDE_SCHEMA_VERSION } from "../core/api-guide-types.js";
import { isApiLearnEnabled } from "../core/api-toggle.js";
import { appendFooter, contentText } from "./utils.js";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface ShapeSummary {
	topLevel: "object" | "array" | "number" | "string" | "boolean" | "null";
	isArray: boolean;
	/** Top-level keys when an object (capped at 20). */
	keys: string[];
	/** Length when the body (or the items array) is an array. */
	arrayLen: number;
	/** Suggested executor. `paginate` for any list; `restGet` for singles. */
	suggestedVia: "restGet" | "paginate";
	/** `itemsPath` for `paginate` — `$` for a bare top-level array. Empty for restGet. */
	suggestedItemsPath: string;
	/** Body keys that look like pagination signals. */
	paginationMarkers: string[];
	/** First record's id-ish field, for reuse as a detail-lookup path param. */
	representativeId?: { field: string; value: string | number };
}

export interface ProbeResult {
	url: string;
	/** Final URL after redirects (equals `url` when no hop occurred). */
	finalUrl: string;
	status: number;
	ok: boolean;
	shape: ShapeSummary | null;
	/** Draft YAML operation block (empty on non-2xx / non-JSON). */
	draft: string;
	/** Truncated raw body for eyeballing. */
	raw: string;
	/** Human note (auth-required, 404, version-prefix hit, non-JSON, …). */
	note?: string;
}

export interface ProbeOptions {
	/** Accept header (default application/json). */
	accept?: string;
	/** On 404, walk the apiHost version backward (vN→v1). Default true. */
	walkVersions?: boolean;
	/**
	 * Store-backed auth injection for probing auth-gated endpoints
	 * (authoring loop). Injection fields only — no kind/requires/optional.
	 * Values resolve from the secrets store and never enter the transcript.
	 */
	auth?: {
		/** Maps header name → secret name, same direction as the guide schema. */
		secretRefs?: Record<string, string>;
		secretQueryRefs?: Record<string, string>;
		/**
		 * Header name → prefix prepended to the resolved secret value (e.g.
		 * `Authorization: "Bearer "`). The store holds the raw token; the prefix
		 * is API knowledge. Keys must be present in `secretRefs`.
		 */
		headerPrefixes?: Record<string, string>;
	};
	/** Domain for secrets-store lookups; defaults to apiHost's hostname. */
	domain?: string;
	/**
	 * Emit a full recipe skeleton (frontmatter + auth + operations) when no
	 * guide exists for the domain; auto-degrades to a single op block + merge
	 * note when one or more guides already claim the domain (D11). Opt-in —
	 * without it the output is today's op-block-only draft.
	 */
	scaffold?: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Pure shape logic — the non-trivial part, exported for testing
// ═══════════════════════════════════════════════════════════════════

const PAGINATION_KEYS = new Set([
	"offset",
	"limit",
	"start",
	"endOfRecords",
	"page",
	"per_page",
	"continue",
	"cursor",
	"next",
	"nextLink",
	"next_page_url",
	"total_count",
	"count",
	"total",
	"numFound",
]);
const ARRAY_VALUE_KEYS = new Set([
	"results",
	"items",
	"search",
	"docs",
	"data",
	"records",
	"features",
	"releases",
	"commits",
	"issues",
	"events",
]);
const ID_FIELDS = [
	"id",
	"key",
	"sha",
	"usageKey",
	"node_id",
	"number",
	"uuid",
	"_id",
];

export function summarize(data: unknown): ShapeSummary {
	const topLevel = topLevelOf(data);
	const keys = isObj(data) ? Object.keys(data as object).slice(0, 20) : [];
	const paginationMarkers = keys.filter((k) => PAGINATION_KEYS.has(k));

	// Find the items array: either the body itself, or the first array-valued
	// key (preferring known envelope keys, then any array key).
	let itemsPath = "";
	let items: unknown[] | null = null;
	if (Array.isArray(data)) {
		itemsPath = "$";
		items = data;
	} else if (isObj(data)) {
		const entries = Object.entries(data as Record<string, unknown>);
		const hit =
			entries.find(([k, v]) => ARRAY_VALUE_KEYS.has(k) && Array.isArray(v)) ??
			entries.find(([, v]) => Array.isArray(v));
		if (hit) {
			itemsPath = hit[0];
			items = hit[1] as unknown[];
		}
	}

	const arrayLen = items?.length ?? 0;
	const hasPaginationSignal = paginationMarkers.length > 0;
	const suggestedVia =
		items === null || !hasPaginationSignal ? "restGet" : "paginate";

	const summary: ShapeSummary = {
		topLevel,
		isArray: Array.isArray(data),
		keys,
		arrayLen,
		suggestedVia,
		suggestedItemsPath: items === null ? "" : itemsPath,
		paginationMarkers,
	};
	const representativeId = pickRepresentativeId(items);
	if (representativeId) summary.representativeId = representativeId;
	return summary;
}

function topLevelOf(data: unknown): ShapeSummary["topLevel"] {
	if (data === null) return "null";
	if (Array.isArray(data)) return "array";
	return typeof data as ShapeSummary["topLevel"];
}

function isObj(data: unknown): data is object {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}

function pickRepresentativeId(
	items: unknown[] | null,
): { field: string; value: string | number } | undefined {
	const rec = items?.[0];
	if (!isObj(rec)) return undefined;
	const obj = rec as Record<string, unknown>;
	for (const f of ID_FIELDS) {
		const v = obj[f];
		if (typeof v === "string" || typeof v === "number")
			return { field: f, value: v };
	}
	return undefined;
}

// ═══════════════════════════════════════════════════════════════════
// IO wrapper — fetches via the shared transport and formats the answer
// ═══════════════════════════════════════════════════════════════════

/** Resolved probe auth — store values + the names/values to redact/scrub. */
interface ProbeAuthCtx {
	hasAuthBlock: boolean;
	headers: Record<string, string>;
	queryParams: Record<string, string>;
	secretHeaderNames: Set<string>;
	secretQueryParamNames: Set<string>;
	secretValues: string[];
	missingNames: string[];
}

/**
 * Resolve an inline `auth` block against the secrets store. Probe semantics:
 * a store miss is NOT fail-closed (human-in-the-loop authoring tool) — the
 * missing name is reported and the call proceeds with the header/param
 * omitted. `requires`/`optional` are absent from the probe's injection-only
 * block, so every miss lands in the report list.
 */
function resolveProbeAuth(
	auth: NonNullable<ProbeOptions["auth"]> | undefined,
	domain: string,
): ProbeAuthCtx {
	const hasRefs =
		!!auth &&
		(Object.keys(auth.secretRefs ?? {}).length > 0 ||
			Object.keys(auth.secretQueryRefs ?? {}).length > 0);
	if (!hasRefs) {
		return {
			hasAuthBlock: false,
			headers: {},
			queryParams: {},
			secretHeaderNames: new Set(),
			secretQueryParamNames: new Set(),
			secretValues: [],
			missingNames: [],
		};
	}
	const headerRes = resolveSecretHeaders(
		{
			kind: "static-key",
			...(auth!.secretRefs ? { secretRefs: auth!.secretRefs } : {}),
			...(auth!.headerPrefixes ? { headerPrefixes: auth!.headerPrefixes } : {}),
		},
		domain,
	);
	const queryRes = resolveSecretQueryParams(
		{
			kind: "static-key",
			...(auth!.secretQueryRefs ? { secretQueryRefs: auth!.secretQueryRefs } : {}),
		},
		domain,
	);
	return {
		hasAuthBlock: true,
		headers: headerRes.headers,
		queryParams: queryRes.queryParams,
		secretHeaderNames: new Set(
			Object.keys(headerRes.headers).map((h) => h.toLowerCase()),
		),
		secretQueryParamNames: new Set(Object.keys(queryRes.queryParams)),
		secretValues: [
			...Object.values(headerRes.headers),
			...headerRes.rawHeaderValues,
			...Object.values(queryRes.queryParams),
		],
		missingNames: [
			...headerRes.absentRequired,
			...headerRes.absentOptional,
			...queryRes.absentRequired,
			...queryRes.absentOptional,
		],
	};
}

/** First missing secret name as a one-line note (names only, never values). */
function missNote(authCtx: ProbeAuthCtx, domain: string): string {
	if (authCtx.missingNames.length === 0) return "";
	return (
		`secret "${authCtx.missingNames[0]}" not found in store for domain "${domain}"` +
		provisionedDomainsSuffix(domain)
	);
}

/** Hostname of an apiHost URL (falls back to the raw string). */
function hostnameOf(apiHost: string): string {
	try {
		return new URL(apiHost).hostname;
	} catch {
		return apiHost;
	}
}

/** Trailing path of an apiHost URL (e.g. `/v3`), or `""` when empty/root.
 *  Trailing slashes stripped so `.../v3/` + `/items` → `/v3/items`, not `/v3//items`.
 *  Lets the probe draft carry the version prefix that was actually fetched. */
function versionPrefixOf(apiHost: string): string {
	try {
		return new URL(apiHost).pathname.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

export async function probe(
	apiHost: string,
	path: string,
	params: Record<string, unknown> = {},
	opts: ProbeOptions = {},
): Promise<ProbeResult> {
	const accept = opts.accept ?? "application/json";
	const walkVersions = opts.walkVersions ?? true;
	const domain = opts.domain ?? hostnameOf(apiHost);
	const authCtx = resolveProbeAuth(opts.auth, domain);

	// Base case only carries the apiHost version prefix; a walk-hit draft
	// embeds its walked version in the prefix passed to fetchOne.
	const base = await fetchOne(
		apiHost,
		path,
		params,
		accept,
		authCtx,
		domain,
		versionPrefixOf(apiHost),
		opts,
	);
	if (base.status !== 404 || !walkVersions || /^\/v\d+\//.test(path)) {
		return base;
	}
	// Recover an over-claimed version by walking the apiHost version backward
	// (vN-1 → … → 1). Only fires on 404 — never a poller on a live 200.
	const stated = VERSION_PATHNAME_RE.exec(versionPrefixOf(apiHost))?.[1];
	if (stated === undefined) {
		// Gate excludes a bare / non-integer / subdomain-versioned host — no
		// walk to run, so tell the agent why rather than a silent bare 404.
		base.note = walkSkipNote(authCtx, domain);
		return base;
	}
	const hit = await walkBackward(
		{ apiHost, path, params, accept, authCtx, domain, opts },
		Number(stated),
	);
	return hit ?? base;
}

// ponytail: MAX_VERSION_WALK caps a high-version host's request burst
// (a /v10 host fires at most 5 backward walks, not 9); raise it if a longer
// version-gap chain is ever needed.
export const MAX_VERSION_WALK = 5;

/** Matches a pure integer version pathname (`/v3`), excluding date/non-numeric
 *  /subdomain /multi-segment conventions — the only form the walk can swap. */
const VERSION_PATHNAME_RE = /^\/v(\d+)$/;

/** Backward version walk: refetch the same bare path with /vN-… swapped into
 *  apiHost; return the first non-404 (with a version-walk note) or null. */
async function walkBackward(
	ctx: {
		apiHost: string;
		path: string;
		params: Record<string, unknown>;
		accept: string;
		authCtx: ProbeAuthCtx;
		domain: string;
		opts: ProbeOptions;
	},
	start: number,
): Promise<ProbeResult | null> {
	const miss = missNote(ctx.authCtx, ctx.domain);
	const floor = Math.max(start - MAX_VERSION_WALK, 1);
	for (let k = start - 1; k >= floor; k--) {
		const tried = await fetchOne(
			withVersion(ctx.apiHost, k),
			ctx.path,
			ctx.params,
			ctx.accept,
			ctx.authCtx,
			ctx.domain,
			`/v${k}`,
			ctx.opts,
		);
		if (tried.status !== 404) {
			// A walk hit may itself have redirected (e.g. /v2 301→ /v3); the
			// draft carries /v${k} while the body came from elsewhere — flag
			// it so the agent checks finalUrl instead of trusting the prefix.
			const redirected = tried.finalUrl !== tried.url;
			tried.note = `${miss ? miss + " — " : ""}404 on /v${start}${ctx.path}; version walk → /v${k}${redirected ? " — verify finalUrl (redirect target)" : ""}`;
			return tried;
		}
	}
	return null;
}

/** apiHost with the version segment swapped via the URL API — never a
 *  string-replace (the version string could appear elsewhere in the host). */
function withVersion(apiHost: string, k: number): string {
	try {
		const u = new URL(apiHost);
		u.pathname = `/v${k}`;
		return `${u.origin}${u.pathname}`;
	} catch {
		return apiHost;
	}
}

/** The gate-excluded 404 note (bare / non-integer / subdomain version hosts). */
function walkSkipNote(authCtx: ProbeAuthCtx, domain: string): string {
	const miss = missNote(authCtx, domain);
	return `${miss ? miss + " — " : ""}404 — no version walk (apiHost has no /vN prefix)`;
}

async function fetchOne(
	apiHost: string,
	path: string,
	params: Record<string, unknown>,
	accept: string,
	authCtx: ProbeAuthCtx,
	domain: string,
	prefix = "",
	opts: ProbeOptions = {},
): Promise<ProbeResult> {
	// Inject secret query params below the agent-supplied params map, then
	// redact the surfaced URL so the real key never reaches the transcript.
	const rawUrl = buildUrl(apiHost, path, { ...params, ...authCtx.queryParams });
	const url = redactSecretParams(rawUrl, authCtx.secretQueryParamNames);
	const hasQuerySecret = Object.keys(authCtx.queryParams).length > 0;
	const res = await fetchUrl(rawUrl, {
		headers: { accept, ...authCtx.headers },
		fresh: true,
		...(authCtx.hasAuthBlock
			? {
					hasQuerySecret,
					secretHeaderNames: authCtx.secretHeaderNames,
				}
			: {}),
	});
	// Probe-local body scrub: the probe bypasses checkResponseStatus, so
	// scrub known secret values from the raw slice directly — a 401 body
	// echoing the key must not leak it into agent context.
	const raw = scrubSecretValues(res.body.slice(0, 800), authCtx.secretValues);
	const finalUrl = redactSecretParams(
		res.finalUrl ?? rawUrl,
		authCtx.secretQueryParamNames,
	);

	if (res.status >= 400) {
		const is401 = res.status === 401 || res.status === 403;
		const miss = missNote(authCtx, domain);
		let note: string;
		if (authCtx.hasAuthBlock) {
			// Auth block present → never the stale auth:none text; report the
			// store miss (or a bare requires-auth hint when nothing was missing).
			note = `${res.status}${is401 ? " — requires authentication?" : ""}${miss ? ` ${miss}` : ""}`;
		} else {
			// No auth block → the existing auth:none wording.
			note = is401
				? `${res.status} — requires authentication? (guide is auth:none)`
				: `${res.status}`;
		}
		return {
			url,
			finalUrl,
			status: res.status,
			ok: false,
			shape: null,
			draft: "",
			raw,
			note,
		};
	}

	let data: unknown;
	try {
		data = JSON.parse(res.body);
	} catch {
		return {
			url,
			finalUrl,
			status: res.status,
			ok: true,
			shape: null,
			draft: "",
			raw,
			note:
				"non-JSON body (set opts.accept for XML/HTML, or use a different path)",
		};
	}

	const shape = summarize(data);
	const miss = missNote(authCtx, domain);
	let draft = emitDraft(path, params, shape, prefix);
	let note: string | undefined = miss;
	if (opts.scaffold && draft) {
		const sc = emitScaffold({ apiHost, domain, draft, auth: opts.auth });
		draft = sc.draft;
		if (sc.note) note = [note, sc.note].filter(Boolean).join(" — ");
	}
	return {
		url,
		finalUrl,
		status: res.status,
		ok: true,
		shape,
		draft,
		raw,
		...(note ? { note } : {}),
	};
}

const RESERVED_PARAM_NAMES = new Set(["domain", "apiHost", "path", "auth"]);

function buildUrl(
	apiHost: string,
	path: string,
	params: Record<string, unknown>,
): string {
	for (const key of Object.keys(params)) {
		if (RESERVED_PARAM_NAMES.has(key)) {
			throw new Error(
				`"${key}" is a top-level param, not a query param — move it out of params`,
			);
		}
	}
	// Substitute {token} → params[token] BEFORE building the URL, so a
	// templated path fetches real values instead of literal %7Bowner%7D.
	// Missing tokens stay literal ({token}) — fine for probing an unfilled path.
	const pathTokens = new Set(extractPathTokens(path));
	const substituted = fillPathTemplate(path, params);
	const qs = new URLSearchParams(
		Object.fromEntries(
			Object.entries(params)
				.filter(([k, v]) => v !== undefined && !pathTokens.has(k))
				.map(([k, v]) => [k, String(v)]),
		),
	).toString();
	return joinUrl(apiHost, substituted, qs);
}

// ═══════════════════════════════════════════════════════════════════
// Draft YAML emission (suggests; the author confirms)
// ═══════════════════════════════════════════════════════════════════

export function emitDraft(
	path: string,
	params: Record<string, unknown>,
	shape: ShapeSummary,
	prefix = "",
): string {
	// Idempotent: only prepend when the path doesn't already carry the prefix,
	// so `apiHost: .../v3` + `path: /v3/items` doesn't become `/v3/v3/items`.
	if (prefix && !path.startsWith(prefix)) path = prefix + path;
	const name = suggestName(path);
	const pathTokens = extractPathTokens(path);
	const queryParamKeys = Object.keys(params).filter(
		(k) => !pathTokens.includes(k),
	);
	const lines: string[] = [
		`  - name: ${name}`,
		`    via: ${shape.suggestedVia}`,
		`    path: ${path}`,
		`    accept: json`,
	];

	if (shape.suggestedVia === "paginate") {
		lines.push(
			"    # unverified — pagination params are guessed from response keys; confirm the API accepts them",
		);
		const style =
			shape.paginationMarkers.includes("page") ||
			shape.paginationMarkers.includes("per_page")
				? "page"
				: "offset-limit";
		const pageParam = style === "page" ? "page" : "offset";
		const pageSizeParam = style === "page" ? "per_page" : "limit";
		lines.push("    pagination:");
		lines.push(`      style: ${style}`);
		lines.push(`      itemsPath: ${shape.suggestedItemsPath}`);
		lines.push(`      pageParam: ${pageParam}`);
		lines.push(`      pageSizeParam: ${pageSizeParam}`);
		lines.push("      pageSize: 30");
	}
	if (shape.suggestedVia === "restGet" && shape.suggestedItemsPath !== "") {
		lines.push(
			"    # array response with no pagination markers — if the API documents paging, prefer paginate; otherwise use restGet.",
		);
	}
	if (queryParamKeys.length > 0) {
		lines.push("    params:");
		for (const k of queryParamKeys) {
			lines.push(`      ${k}:`);
			lines.push(`        description: TODO — ${k}.`);
		}
	}
	if (shape.representativeId) {
		lines.push(
			`    # representative id: ${shape.representativeId.field}=${shape.representativeId.value}`,
		);
	}
	return lines.join("\n");
}

function suggestName(path: string): string {
	const segs = path.split("/").filter((s) => s && !s.startsWith("{"));
	const last = segs[segs.length - 1] ?? "op";
	// kebab/snake → camelCase placeholder; author renames.
	return last
		.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase())
		.replace(/[^a-zA-Z0-9]/g, "");
}

// ═══════════════════════════════════════════════════════════════════
// Scaffold emission (D6 probe-scaffold + D11 auto-degrade)
// ═══════════════════════════════════════════════════════════════════

/**
 * Translate the probe's auth-injection params into a `kind: static-key` auth
 * block (issue #4 close: probe auth shape now matches the guide schema).
 * `requires` = the union of secret names referenced by the refs. Returns
 * undefined when no injection refs are declared (auth: none default).
 */
function emitAuthBlock(
	auth: NonNullable<ProbeOptions["auth"]> | undefined,
): string | undefined {
	const refs = auth?.secretRefs ?? {};
	const queryRefs = auth?.secretQueryRefs ?? {};
	const prefixes = auth?.headerPrefixes ?? {};
	const names = [
		...new Set([...Object.values(refs), ...Object.values(queryRefs)]),
	];
	if (names.length === 0) return undefined;
	const lines = [
		"auth:",
		"  kind: static-key",
		`  requires: [${names.join(", ")}]`,
	];
	if (Object.keys(refs).length > 0) {
		lines.push("  secretRefs:");
		for (const [header, secret] of Object.entries(refs))
			lines.push(`    ${header}: ${secret}`);
	}
	if (Object.keys(queryRefs).length > 0) {
		lines.push("  secretQueryRefs:");
		for (const [param, secret] of Object.entries(queryRefs))
			lines.push(`    ${param}: ${secret}`);
	}
	if (Object.keys(prefixes).length > 0) {
		lines.push("  headerPrefixes:");
		for (const [header, prefix] of Object.entries(prefixes))
			lines.push(`    ${header}: "${prefix}"`);
	}
	return lines.join("\n");
}

/**
 * Full recipe skeleton (bootstrap): frontmatter + auth + the probe's op
 * block. `schemaVersion` literal matches what api-learn stamps on save, so a
 * scaffolded guide is detection-ready the moment it's saved. Pagination stays
 * op-level only (a single probe justifies one op's pagination, never a
 * top-level default — issue #5 guardrail).
 */
function emitScaffoldSkeleton(opts: {
	apiHost: string;
	domain: string;
	draft: string;
	auth: ProbeOptions["auth"];
}): string {
	const lines = [
		"---",
		"kind: api",
		`domains: [${opts.domain}]`,
		`apiHost: ${opts.apiHost}`,
		"responseShape:",
		"  format: json",
		"gatherAllMax: 1000",
		`schemaVersion: ${GUIDE_SCHEMA_VERSION}`,
	];
	const authBlock = emitAuthBlock(opts.auth);
	if (authBlock) lines.push("", authBlock);
	// Trailing "" gives the closing `---` its required trailing newline.
	lines.push("", "operations:", opts.draft, "---", "");
	return lines.join("\n");
}

/**
 * D11 scaffold decision, driven by findGuidesByDomain(domain): 0 guides →
 * full skeleton (bootstrap); 1 guide → op block + merge note naming the one
 * dirName; N guides → op block + merge note listing every candidate dirName
 * (the merge-target choice defers to api-learn's selector). Returns the
 * paste-able draft + an optional human merge note.
 */
function emitScaffold(opts: {
	apiHost: string;
	domain: string;
	draft: string;
	auth: ProbeOptions["auth"];
}): { draft: string; note?: string } {
	const matches = findGuidesByDomain(opts.domain);
	if (matches.length === 0) {
		return { draft: emitScaffoldSkeleton(opts) };
	}
	const dirs = matches.map((m) => m.dirName);
	const note =
		matches.length === 1
			? `scaffold: guide already exists — merge into \`${dirs[0]}\``
			: `scaffold: ${matches.length} guides already exist — merge into one of: ${dirs.join(", ")}`;
	return { draft: opts.draft, note };
}

// ═══════════════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════════════

export const apiProbeTool = defineTool({
	name: "api-probe",
	label: "API Probe",
	description:
		"Discover the shape of a not-yet-guided API endpoint before authoring a guide. " +
		"Fetches a templated path over the real transport, summarizes the JSON shape, " +
		"suggests via/itemsPath/pagination, echoes a representative record id, and emits " +
		"a draft YAML operation block to paste into a guide recipe. " +
		"It only suggests — it never writes the guide, and the operation must still be " +
		"traceable to your plan source. Pre-guide: pass apiHost + path. After a guide " +
		"exists, use api-guide({domain}) to get apiHost, or api-fetch to execute. " +
		"Before the first auth-gated probe, call with listSecrets: true (and no domain) " +
		"to list every provisioned store domain and which already have guides — pass that " +
		"domain up front so a store-miss round-trip is avoided. " +
		"Before authoring a new guide, read the provider's docs index (llms.txt, " +
		"openapi.json at the API root, or the docs page) to learn the current API " +
		"version — then probe that version explicitly. Do not default the version from " +
		"memory: a stale version that still returns 200 is not detected as old (the " +
		"backward walk only fires on 404). The probe recovers an over-claimed version " +
		"but cannot detect a stale-but-working one. " +
		"Pass scaffold: true to emit a full recipe skeleton (frontmatter + auth + " +
		"operations) when no guide exists for the domain; it auto-degrades to a single " +
		"op block + merge note when one or more guides already claim the domain.",

	parameters: Type.Object({
		apiHost: Type.Optional(
			Type.String({
				description:
					"Base URL including the API's current version prefix, e.g. " +
					"'https://api.example.com/v3'. Find the latest version before probing: " +
					"check the API's docs page, openapi.json/swagger.json at the API root, " +
					"or llms.txt. Supply the newest version you can verify — if it 404s, the " +
					"probe walks backward (v3→v2→v1) to recover. Do not default to /v1 from " +
					"memory; a stale version that still returns 200 is not detected as old.",
			}),
		),
		path: Type.Optional(
			Type.String({
				description:
					"Templated path, e.g. '/repos/{owner}/{repo}/branches'. {token} placeholders are filled from params.",
			}),
		),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					"Values for {token} path placeholders and query parameters. Path tokens are not re-declared as query params.",
			}),
		),
		walkVersions: Type.Optional(
			Type.Boolean({
				description:
					"On 404, walk the apiHost version backward (vN→v1) to find the highest live version. Default true.",
			}),
		),
		scaffold: Type.Optional(
			Type.Boolean({
				description:
					"Emit a full recipe skeleton (frontmatter + auth + operations) when no guide exists for the domain; " +
					"auto-degrades to a single op block + merge note when one or more guides already claim the domain. " +
					"Opt-in — without it the output is today's op-block-only draft.",
			}),
		),
		auth: Type.Optional(
			Type.Object(
				{
					secretRefs: Type.Optional(Type.Record(Type.String(), Type.String())),
					secretQueryRefs: Type.Optional(Type.Record(Type.String(), Type.String())),
					headerPrefixes: Type.Optional(Type.Record(Type.String(), Type.String())),
				},
				{
					description:
						"Store-backed auth injection for probing auth-gated endpoints (authoring loop). Injection fields only — values resolve from the secrets store and never enter the transcript; a store miss fetches unauthenticated and reports the miss in the note.",
					// Tight: unknown keys (e.g. a stray `domain`) are rejected before execute runs.
					additionalProperties: false,
				},
			),
		),
		domain: Type.Optional(
			Type.String({
				description:
					"Domain for secrets-store lookups; defaults to apiHost's hostname.",
			}),
		),
		listSecrets: Type.Optional(
			Type.Boolean({
				description:
					"Names only, never values. Two modes: with no domain/apiHost, lists " +
					"provisioned-but-guideless store domains (authoring-bootstrap view — " +
					"call this empty first to see what's provisioned); with a domain (or " +
					"apiHost), lists provisioned secret names for that domain, with " +
					"declared-vs-stored gaps when a guide exists.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { apiHost, path, walkVersions, auth, domain, listSecrets, scaffold } =
			params as {
				apiHost?: string;
				path?: string;
				params?: Record<string, unknown>;
				walkVersions?: boolean;
				auth?: {
					secretRefs?: Record<string, string>;
					secretQueryRefs?: Record<string, string>;
				};
				domain?: string;
				listSecrets?: boolean;
				scaffold?: boolean;
			};
		const userParams = (params as Record<string, unknown>)["params"] as
			| Record<string, unknown>
			| undefined;

		// Learn-gated secrets discovery — short-circuits the fetch entirely.
		// The agent's only programmatic path to the secrets store; /api secrets is
		// user-typed only. Names only, never values.
		if (listSecrets === true) {
			if (!isApiLearnEnabled()) {
				return {
					content: [
						{
							type: "text",
							text:
								"api-probe: listSecrets: true is learn mode only — run /api learn first.",
						},
					],
					details: { error: "learn_mode_only" },
				};
			}
			// Bare call (no domain, no apiHost): orphan list only. apiHost present:
			// orphan list first, then the per-domain view. domain present: unchanged.
			const unscoped = domain ? undefined : unscopedStoreDomains();
			const blocks: string[] = [];
			if (unscoped !== undefined) blocks.push(formatUnscopedDomains(unscoped));
			const target = domain ?? (apiHost ? hostnameOf(apiHost) : undefined);
			if (target !== undefined) {
				const secrets = listDomainSecrets(target);
				blocks.push(formatSecretsResult(secrets));
				// apiHost/domain present means a real probe was suppressed by
				// listSecrets: true — say so, or the author silently loses the probe.
				blocks.push(
					"probe suppressed because listSecrets: true — drop listSecrets to probe.",
				);
				return {
					content: [{ type: "text", text: blocks.join("\n\n") }],
					details: unscoped === undefined ? { secrets } : { secrets, unscoped },
				};
			}
			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: { unscoped: unscoped! },
			};
		}

		// apiHost/path are optional in the schema so the bare listSecrets call is
		// legal; every real probe needs both. The schema no longer enforces it,
		// so guard here before falling through to probe(). (The listSecrets:true
		// branch always returns above, so this guard only sees non-listSecrets.)
		if (!apiHost || !path) {
			return {
				content: [
					{
						type: "text",
						text:
							"api-probe: apiHost and path are required unless listSecrets: true.",
					},
				],
				details: { error: "missing_apiHost_or_path" },
			};
		}

		try {
			const result = await probe(apiHost, path, userParams ?? {}, {
				...(walkVersions === undefined ? {} : { walkVersions }),
				...(auth ? { auth } : {}),
				...(domain ? { domain } : {}),
				...(scaffold === undefined ? {} : { scaffold }),
			});
			return {
				content: [{ type: "text", text: formatProbeResult(result) }],
				details: {
					url: result.url,
					finalUrl: result.finalUrl,
					status: result.status,
					ok: result.ok,
					shape: result.shape,
					note: result.note,
					draft: result.draft,
					raw: result.raw,
				},
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text",
						text: `api-probe failed for '${apiHost}${path}': ${
							err instanceof Error ? err.message : String(err)
						}`,
					},
				],
				details: { error: "unexpected", message: String(err) },
			};
		}
	},

	renderCall(args, theme, _context) {
		const parts: string[] = [theme.fg("toolTitle", theme.bold("api-probe "))];
		if (args.apiHost) parts.push(theme.fg("accent", `"${args.apiHost}"`));
		if (args.path) parts.push(theme.fg("dim", `› ${args.path}`));
		if (args.scaffold) parts.push(theme.fg("dim", "· scaffold"));
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Probing…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) {
			return new Text(theme.fg("error", `⚠ ${contentText(result, "?")}`), 0, 0);
		}
		// Secrets first: the domain-scoped view is the primary output and is present
		// for both the per-domain and combined (apiHost-no-domain) shapes. Only the
		// bare call (no domain/apiHost) carries unscoped alone.
		const secrets = d?.secrets as
			| { domain: string; provisioned: string[] }
			| undefined;
		if (secrets) {
			const text = theme.fg("accent", theme.bold("🔑 api-probe"));
			return new Text(
				appendFooter(
					text +
						` — secrets for ${secrets.domain} · ${secrets.provisioned.length} provisioned`,
					expanded,
					result,
					theme,
					1000,
				),
				0,
				0,
			);
		}
		const unscoped = d?.unscoped as string[] | undefined;
		if (unscoped) {
			const text = theme.fg("accent", theme.bold("🔑 api-probe"));
			return new Text(
				appendFooter(
					text + ` — ${unscoped.length} unscoped domains`,
					expanded,
					result,
					theme,
					1000,
				),
				0,
				0,
			);
		}
		const status = d?.status as number | undefined;
		const shape = d?.shape as ShapeSummary | null | undefined;

		let text = theme.fg("accent", theme.bold("🔬 api-probe"));
		text += ` — ${(d?.url as string) ?? "?"} · ${status ?? "?"}`;
		if (shape) {
			const items =
				shape.suggestedVia === "paginate"
					? ` · itemsPath: ${shape.suggestedItemsPath}`
					: "";
			text += `\n${theme.fg("dim", `${shape.suggestedVia}${items}`)}`;
		}
		return new Text(appendFooter(text, expanded, result, theme, 1000), 0, 0);
	},
});

// ═══════════════════════════════════════════════════════════════════
// Result formatting
// ═══════════════════════════════════════════════════════════════════

const DOCS_NUDGE = [
	"probe validates shape only — it cannot enumerate endpoints.",
	"For a full guide, read the API's docs index (e.g. llms.txt or per-endpoint .md).",
];

export function formatProbeResult(r: ProbeResult): string {
	const lines: string[] = [];
	lines.push(`🔬 api-probe — ${r.url}`);
	lines.push(`  status: ${r.status}`);
	if (r.finalUrl !== r.url) lines.push(`  final url: ${r.finalUrl}`);
	if (r.note) lines.push(`  note: ${r.note}`);
	if (r.shape) {
		const s = r.shape;
		lines.push(`  shape: ${s.topLevel}`);
		if (s.keys.length > 0) lines.push(`  keys: ${s.keys.join(", ")}`);
		lines.push(`  via: ${s.suggestedVia}`);
		if (s.suggestedItemsPath) lines.push(`  itemsPath: ${s.suggestedItemsPath}`);
		if (s.arrayLen > 0) lines.push(`  arrayLen: ${s.arrayLen}`);
		if (s.paginationMarkers.length > 0)
			lines.push(`  pagination markers: ${s.paginationMarkers.join(", ")}`);
		if (s.representativeId)
			lines.push(
				`  representative id: ${s.representativeId.field}=${s.representativeId.value}`,
			);
	}
	if (r.draft) {
		lines.push(`  draft:`);
		lines.push(r.draft.replace(/^/gm, "    "));
	}
	if (r.raw) {
		lines.push(`  raw (truncated):`);
		lines.push(r.raw);
	}
	lines.push("");
	lines.push(`  ${DOCS_NUDGE.join("\n  ")}`);
	return lines.join("\n");
}

/** Store domains that are provisioned but not scoped to any guide.
 *  Authoring-loop diagnostic: surfaces bootstrap + migration-orphan
 *  secrets. Names only. */
function unscopedStoreDomains(): string[] {
	return listDomains().filter((d) => findGuidesByDomain(d).length === 0);
}

function formatUnscopedDomains(domains: string[]): string {
	const lines: string[] = ["🗂 unscoped store domains (provisioned, no guide)"];
	lines.push(`  ${domains.length > 0 ? domains.join(", ") : "(none)"}`);
	lines.push("  (names only — values never leave the store)");
	return lines.join("\n");
}

/** List mode: provisioned secret names for a domain (names only). */
function listDomainSecrets(domain: string): {
	domain: string;
	provisioned: string[];
	declared?: string[];
} {
	const provisioned = listNames(domain);
	const matches = findGuidesByDomain(domain);
	if (matches.length === 0) return { domain, provisioned };
	const declaredSet = new Set<string>();
	for (const { guide } of matches) {
		for (const n of [
			...(guide.auth.requires ?? []),
			...(guide.auth.optional ?? []),
		]) {
			declaredSet.add(n);
		}
	}
	const declared = [...declaredSet].sort();
	return { domain, provisioned, declared };
}

function formatSecretsResult(s: {
	domain: string;
	provisioned: string[];
	declared?: string[];
}): string {
	const lines: string[] = [`🔑 secrets for ${s.domain}`];
	lines.push(
		`  provisioned: ${s.provisioned.length > 0 ? s.provisioned.join(", ") : "(none)"}`,
	);
	if (s.declared !== undefined) {
		lines.push(
			`  declared: ${s.declared.length > 0 ? s.declared.join(", ") : "(none)"}`,
		);
		const gaps = s.declared.filter((d) => !s.provisioned.includes(d));
		if (gaps.length > 0) lines.push(`  gaps: ${gaps.join(", ")}`);
	}
	lines.push("  (names only — values never leave the store)");
	return lines.join("\n");
}
