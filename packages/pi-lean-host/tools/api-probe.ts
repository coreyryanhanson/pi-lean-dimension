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
import { fetchUrl } from "../core/transport.js";
import {
	extractPathTokens,
	fillPathTemplate,
	joinUrl,
} from "../core/path-template.js";
import {
	resolveSecretHeaders,
	resolveSecretQueryParams,
} from "../core/auth.js";
import { listDomains, listNames } from "../core/secrets-store.js";
import { findGuidesByDomain } from "../core/guide-store.js";
import { redactSecretParams } from "../core/helpers.js";
import { isApiLearnEnabled } from "../core/api-toggle.js";
import { contentText, renderExpandedText } from "./utils.js";

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
	/** On 404, auto-try /v1/ and /v2/ prefixes. Default true. */
	tryPrefixes?: boolean;
	/**
	 * Store-backed auth injection for probing auth-gated endpoints
	 * (authoring loop). Injection fields only — no kind/requires/optional.
	 * Values resolve from the secrets store and never enter the transcript.
	 */
	auth?: {
		secretRefs?: Record<string, string>;
		secretQueryRefs?: Record<string, string>;
	};
	/** Domain for secrets-store lookups; defaults to apiHost's hostname. */
	domain?: string;
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
	const suggestedVia = items === null ? "restGet" : "paginate";

	const summary: ShapeSummary = {
		topLevel,
		isArray: Array.isArray(data),
		keys,
		arrayLen,
		suggestedVia,
		suggestedItemsPath: suggestedVia === "paginate" ? itemsPath : "",
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
	return `secret "${authCtx.missingNames[0]}" not found in store for domain "${domain}"`;
}

/** Hostname of an apiHost URL (falls back to the raw string). */
function hostnameOf(apiHost: string): string {
	try {
		return new URL(apiHost).hostname;
	} catch {
		return apiHost;
	}
}

export async function probe(
	apiHost: string,
	path: string,
	params: Record<string, unknown> = {},
	opts: ProbeOptions = {},
): Promise<ProbeResult> {
	const accept = opts.accept ?? "application/json";
	const tryPrefixes = opts.tryPrefixes ?? true;
	const domain = opts.domain ?? hostnameOf(apiHost);
	const authCtx = resolveProbeAuth(opts.auth, domain);

	const base = await fetchOne(apiHost, path, params, accept, authCtx, domain);
	if (base.status === 404 && tryPrefixes && !/^\/v\d+\//.test(path)) {
		for (const p of [`/v1${path}`, `/v2${path}`]) {
			const tried = await fetchOne(apiHost, p, params, accept, authCtx, domain);
			if (tried.status !== 404) {
				const miss = missNote(authCtx, domain);
				tried.note = `${miss ? miss + " — " : ""}404 on ${path}; /v*/ prefix hit → ${p}`;
				return tried;
			}
		}
	}
	return base;
}

async function fetchOne(
	apiHost: string,
	path: string,
	params: Record<string, unknown>,
	accept: string,
	authCtx: ProbeAuthCtx,
	domain: string,
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
	let raw = res.body.slice(0, 800);
	for (const v of authCtx.secretValues) {
		if (v && v.length > 0) raw = raw.split(v).join("***");
	}
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
	return {
		url,
		finalUrl,
		status: res.status,
		ok: true,
		shape,
		draft: emitDraft(path, params, shape),
		raw,
		...(miss ? { note: miss } : {}),
	};
}

function buildUrl(
	apiHost: string,
	path: string,
	params: Record<string, unknown>,
): string {
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
): string {
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
		"exists, use api-guide({domain}) to get apiHost, or api-fetch to execute.",

	parameters: Type.Object({
		apiHost: Type.String({
			description:
				"Base URL including version prefix, e.g. 'https://api.github.com'.",
		}),
		path: Type.String({
			description:
				"Templated path, e.g. '/repos/{owner}/{repo}/branches'. {token} placeholders are filled from params.",
		}),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					"Values for {token} path placeholders and query parameters. Path tokens are not re-declared as query params.",
			}),
		),
		tryPrefixes: Type.Optional(
			Type.Boolean({
				description: "On 404, auto-try /v1/ and /v2/ prefixes. Default true.",
			}),
		),
		auth: Type.Optional(
			Type.Object(
				{
					secretRefs: Type.Optional(Type.Record(Type.String(), Type.String())),
					secretQueryRefs: Type.Optional(Type.Record(Type.String(), Type.String())),
				},
				{
					description:
						"Store-backed auth injection for probing auth-gated endpoints (authoring loop). Injection fields only — values resolve from the secrets store and never enter the transcript; a store miss fetches unauthenticated and reports the miss in the note.",
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
					"Learn mode only: list provisioned secret names for the domain (no fetch). Names only, never values. Refused under /api on.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { apiHost, path, tryPrefixes, auth, domain, listSecrets } = params as {
			apiHost: string;
			path: string;
			params?: Record<string, unknown>;
			tryPrefixes?: boolean;
			auth?: {
				secretRefs?: Record<string, string>;
				secretQueryRefs?: Record<string, string>;
			};
			domain?: string;
			listSecrets?: boolean;
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

		try {
			const result = await probe(apiHost, path, userParams ?? {}, {
				...(tryPrefixes === undefined ? {} : { tryPrefixes }),
				...(auth ? { auth } : {}),
				...(domain ? { domain } : {}),
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
		return new Text(parts.join(" "), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Probing…"), 0, 0);
		const d = result.details as Record<string, unknown> | undefined;
		if (d?.error) {
			return new Text(theme.fg("error", `⚠ ${contentText(result, "?")}`), 0, 0);
		}
		const secrets = d?.secrets as
			| { domain: string; provisioned: string[] }
			| undefined;
		if (secrets) {
			let text = theme.fg("accent", theme.bold("🔑 api-probe"));
			text += ` — secrets for ${secrets.domain} · ${secrets.provisioned.length} provisioned`;
			const content = contentText(result);
			if (expanded) {
				text += "\n";
				text = renderExpandedText(text, theme, content, 1000);
			} else {
				text += `\n${theme.fg("muted", `${content.length} chars (expand)`)}`;
			}
			return new Text(text, 0, 0);
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

		const content = contentText(result);
		if (expanded) {
			text += "\n";
			text = renderExpandedText(text, theme, content, 1000);
		} else {
			text += `\n${theme.fg("muted", `${content.length} chars (expand)`)}`;
		}
		return new Text(text, 0, 0);
	},
});

// ═══════════════════════════════════════════════════════════════════
// Result formatting
// ═══════════════════════════════════════════════════════════════════

function formatProbeResult(r: ProbeResult): string {
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
