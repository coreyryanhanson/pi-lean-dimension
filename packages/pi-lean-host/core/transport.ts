/**
 * HTTP transport layer — per-domain undici Agent with caching and retry.
 *
 * Provides `fetchUrl()` with:
 *  - ETag-based conditional requests (304 → cached body)
 *  - Cache-Control `max-age` TTL
 *  - Retry-on-429 with exponential backoff + `Retry-After` support
 *  - Configurable timeout
 *  - Automatic charset decoding from Content-Type
 *
 * Caching is per-URL, module-level (in-memory map). The cache is
 * transparent to callers; each URL is cached independently.
 */

import { request, Agent, interceptors, type Dispatcher } from "undici";
import { ssrfGuard } from "./ssrf-guard.js";

// ponytail: module-level composed agents; closed only on process exit.
// Add a close() in session_shutdown if leak-detection ever flags it.

/** Auto-follows up to 5 redirects. Used when redirect targets are trusted
 *  (agent-supplied URLs — the agent has bash, so guarding them is theater). */
const redirectAgent = new Agent().compose(
	interceptors.redirect({ maxRedirections: 5 }),
);

/** No auto-redirect. Used with `guardRedirects` so each redirect target is
 *  SSRF-checked before it is followed. See fetchUrl for the manual loop. */
const noRedirectAgent = new Agent();

const MAX_REDIRECTS = 5;

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface FetchOptions {
	/** Request timeout in ms (default: 30_000). */
	timeout?: number;
	/** Additional request headers. */
	headers?: Record<string, string>;
	/** Max retries on 429 (default: 2). */
	maxRetries?: number;
	/** Skip cache (force fresh fetch). */
	fresh?: boolean;
	/** SSRF-check each redirect target before following it. Use only for
	 *  server-supplied URLs (paginate nextLink) — a malicious API can 302
	 *  to an internal host, and when auth headers ship the Authorization
	 *  header would attach to the redirect. Agent-supplied URLs don't need
	 *  this (the agent already has bash). */
	guardRedirects?: boolean;
}

export interface FetchResult {
	status: number;
	headers: Record<string, string>;
	body: string;
	/** True when the result came from cache (no network request). */
	cached: boolean;
	/** Final URL after redirects — present only when at least one hop occurred. */
	finalUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Cache
// ═══════════════════════════════════════════════════════════════════

interface CacheEntry {
	body: string;
	/** ETag for conditional requests; absent when the upstream didn't send one. */
	etag?: string;
	expiresAt: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TTL_MS = 60_000; // 60s fallback when no Cache-Control
const MAX_CACHE_ENTRIES = 100; // ponytail: hard cap; evict soonest-expiring when exceeded
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB ceiling on a single response body

/** Module-level cache: cache-key → CacheEntry. */
const cache = new Map<string, CacheEntry>();

/**
 * Drop expired entries, then — if still over the cap — evict the
 * soonest-expiring entries. Called before every `cache.set`.
 */
function evictCacheIfNeeded(): void {
	if (cache.size < MAX_CACHE_ENTRIES) return;
	const now = Date.now();
	for (const [k, e] of cache) {
		if (e.expiresAt <= now) cache.delete(k);
	}
	if (cache.size >= MAX_CACHE_ENTRIES) {
		const sorted = [...cache.entries()].sort(
			(a, b) => a[1].expiresAt - b[1].expiresAt,
		);
		while (cache.size >= MAX_CACHE_ENTRIES && sorted.length > 0) {
			const next = sorted.shift();
			if (next) cache.delete(next[0]);
		}
	}
}

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Produce a cache key from URL and optional Accept header.
 *
 * Two requests for the same URL with different Accept values are cached
 * separately so that content-negotiated responses don't collide.
 * When no Accept header is present the plain URL is used as the key.
 */
function cacheKey(url: string, opts?: FetchOptions): string {
	const accept = opts?.headers?.accept;
	return accept ? `${url}\x00accept=${accept}` : url;
}

function parseHeaders(
	hdrs: Dispatcher.ResponseData["headers"],
): Record<string, string> {
	const out: Record<string, string> = {};
	if (hdrs && typeof hdrs === "object") {
		// undici returns headers as an object with lowercased keys.
		for (const [key, val] of Object.entries(hdrs)) {
			if (typeof val === "string") {
				out[key.toLowerCase()] = val;
			} else if (Array.isArray(val)) {
				// Repeated headers arrive as string[] — join like raw form.
				out[key.toLowerCase()] = val.join(", ");
			}
		}
	}
	return out;
}

async function collectBody(
	body: Dispatcher.ResponseData["body"],
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		total += chunk.length;
		if (total > MAX_BODY_BYTES) {
			const err = new Error(`Response body exceeded ${MAX_BODY_BYTES} bytes`);
			err.name = "BodyTooLargeError"; // checked by fetchUrl retry logic
			throw err;
		}
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function decodeBuffer(buf: Buffer, charset: string): string {
	const cs = charset.toLowerCase().replace(/[^a-z0-9_-]/g, "");
	if (cs === "utf-8" || cs === "utf8" || cs === "") {
		return buf.toString("utf-8");
	}
	try {
		const decoder = new TextDecoder(cs);
		return decoder.decode(buf);
	} catch {
		// Fallback to utf-8 if TextDecoder doesn't recognise the charset.
		return buf.toString("utf-8");
	}
}

function parseMaxAge(headers: Record<string, string>): number | null {
	const cc = headers["cache-control"];
	if (!cc) return null;
	const m = cc.match(/max-age=(\d+)/i);
	return m ? parseInt(m[1]!, 10) * 1000 : null;
}

function waitForRetry(
	headers: Record<string, string>,
	attempt: number,
): number {
	const raw = headers["retry-after"];
	if (raw) {
		const secs = parseInt(raw, 10);
		if (!isNaN(secs) && secs > 0) return secs * 1000;
	}
	// Exponential backoff: 1s, 2s, 4s, …
	return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * One GET request with its own abort timer. Returns status, parsed headers,
 * and the raw collected body. Redirects are NOT followed here — the caller
 * decides whether to follow and guard them.
 */
async function singleGet(
	url: string,
	reqHeaders: Record<string, string>,
	timeoutMs: number,
	dispatcher: Dispatcher,
): Promise<{
	status: number;
	headers: Record<string, string>;
	rawBody: Buffer;
	finalUrl: string;
}> {
	if (timeoutMs <= 0) throw new Error("Request timeout");
	const ac = new AbortController();
	const timer = setTimeout(
		() => ac.abort(new Error("Request timeout")),
		timeoutMs,
	);
	try {
		const resp = await request(url, {
			method: "GET",
			headers: reqHeaders,
			signal: ac.signal,
			dispatcher,
		});
		// The redirect interceptor records the hop chain in context.history;
		// its last entry is where the response actually came from. No history
		// (no interceptor / no redirect) means the URL is unchanged.
		const history = (resp.context as { history?: URL[] } | null)?.history;
		return {
			status: resp.statusCode,
			headers: parseHeaders(resp.headers),
			rawBody: await collectBody(resp.body),
			finalUrl: history?.at(-1) ? String(history.at(-1)) : url,
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Follow redirects manually, SSRF-checking each target. Used only for
 * server-supplied URLs (paginate nextLink). GET-only, so method is
 * preserved across 301/302/303/307/308 trivially. Returns the final
 * response; a redirect to a blocked host throws before it is fetched.
 */
async function getWithGuardedRedirects(
	url: string,
	reqHeaders: Record<string, string>,
	startTime: number,
	timeoutMs: number,
): Promise<{
	status: number;
	headers: Record<string, string>;
	rawBody: Buffer;
	finalUrl: string;
}> {
	let current = url;
	for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
		const remaining = timeoutMs - (Date.now() - startTime);
		const res = await singleGet(
			current,
			reqHeaders,
			remaining,
			noRedirectAgent,
		);
		const isRedirect =
			res.status >= 300 && res.status < 400 && res.status !== 304;
		if (!isRedirect || hops === MAX_REDIRECTS) return res;
		const loc = res.headers["location"];
		if (!loc) return res; // redirect with no Location — return as-is
		const next = new URL(loc, current).toString();
		const guard = ssrfGuard(next);
		if (!guard.ok) {
			// Security-control failure is not transient — don't retry.
			const err = new Error(`Redirect to blocked host: ${guard.reason}`);
			err.name = "SsrfBlockedError";
			throw err;
		}
		current = next;
	}
	// Unreachable: the loop returns on the MAX_REDIRECTS hop.
	throw new Error("Too many redirects");
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch a URL with caching and retry-on-429.
 *
 * Cache behaviour:
 *  - URLs are cached in a module-level `Map<string, CacheEntry>`.
 *  - TTL from `Cache-Control: max-age=N` or the `DEFAULT_TTL_MS` fallback.
 *  - When a cached entry has an `etag`, the conditional `If-None-Match`
 *    header is sent and a 304 refreshes the cached body's expiry.
 *  - `opts.fresh = true` skips the cache read and bypasses sending
 *    `If-None-Match` (server returns full response).
 *  - Requests carrying caller-specific headers (anything besides Accept,
 *    e.g. API keys) are never cached or served from cache — the response
 *    is private to that caller.
 *
 * Retry behaviour:
 *  - 429 responses are retried up to `opts.maxRetries` times.
 *  - Backoff: if `Retry-After` is present, wait that many seconds;
 *    otherwise exponential backoff (1s, 2s, 4s, capped at 30s).
 *  - Other 4xx/5xx status codes are returned as-is without retry.
 *
 * Network errors (DNS, connection refused, timeout) are thrown.
 */
export async function fetchUrl(
	url: string,
	opts?: FetchOptions,
): Promise<FetchResult> {
	const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
	const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;

	// Responses to requests carrying caller-specific headers (auth keys,
	// tokens, …) are private to that caller — never cache or reuse them.
	// Only the Accept header (content negotiation) is cache-shareable, and
	// it's already part of the cache key. Without this gate, the same URL
	// fetched with two different auth headers would collide on one cache
	// entry and the second caller would get the first caller's response.
	const hasAuthHeaders =
		!!opts?.headers &&
		Object.keys(opts.headers).some((h) => h.toLowerCase() !== "accept");

	// ── cache hit ───────────────────────────────────────────────
	const key = cacheKey(url, opts);
	if (!opts?.fresh && !hasAuthHeaders) {
		const entry = cache.get(key);
		if (entry && Date.now() < entry.expiresAt) {
			return { status: 200, headers: {}, body: entry.body, cached: true };
		}
	}

	// ── request headers ─────────────────────────────────────────
	const reqHeaders: Record<string, string> = { ...opts?.headers };
	if (!reqHeaders["user-agent"]) {
		reqHeaders["user-agent"] =
			"pi-lean-host/0.1.0 (+https://github.com/coreyryanhanson/pi-lean-dimension)";
	}

	if (!opts?.fresh && !hasAuthHeaders) {
		const entry = cache.get(key);
		if (entry?.etag) {
			reqHeaders["If-None-Match"] = entry.etag;
		}
	}

	const startTime = Date.now();

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const remaining = timeout - (Date.now() - startTime);
		if (remaining <= 0) throw new Error("Request timeout");

		try {
			// When guardRedirects is set, follow redirects manually and SSRF-
			// check each target (server-supplied URLs only). Otherwise let
			// undici auto-follow up to 5 redirects.
			const {
				status,
				headers: respHeaders,
				rawBody,
				finalUrl,
			} = opts?.guardRedirects
				? await getWithGuardedRedirects(url, reqHeaders, startTime, timeout)
				: await singleGet(url, reqHeaders, remaining, redirectAgent);

			// ── 304 Not Modified ────────────────────────────────
			if (status === 304) {
				const entry = cache.get(key);
				if (entry) {
					const maxAge = parseMaxAge(respHeaders) ?? DEFAULT_TTL_MS;
					entry.expiresAt = Date.now() + maxAge;
					// 304 refreshes an existing key — no growth, but cap-check is cheap.
					cache.set(key, entry);
					return {
						status: 200,
						headers: respHeaders,
						body: entry.body,
						cached: true,
						...(finalUrl !== url ? { finalUrl } : {}),
					};
				}
				// No cached entry → fall through to process body.
			}

			// ── 429 Too Many Requests ───────────────────────────
			if (status === 429 && attempt < maxRetries) {
				const delay = waitForRetry(respHeaders, attempt);
				await new Promise((r) => setTimeout(r, delay));
				continue; // retry
			}

			// ── decode & cache (2xx only) ───────────────────────
			const contentType = respHeaders["content-type"] ?? "";
			const charsetMatch = contentType.match(/charset\s*=\s*([^\s;]+)/i);
			const charset = charsetMatch?.[1] ?? "utf-8";
			const body = decodeBuffer(rawBody, charset);

			if (status >= 200 && status < 300 && !hasAuthHeaders) {
				const maxAge = parseMaxAge(respHeaders) ?? DEFAULT_TTL_MS;
				const etag = respHeaders["etag"];

				const entry: CacheEntry = { body, expiresAt: Date.now() + maxAge };
				if (etag) entry.etag = etag;
				evictCacheIfNeeded();
				cache.set(key, entry);
			}

			return {
				status,
				headers: respHeaders,
				body,
				cached: false,
				...(finalUrl !== url ? { finalUrl } : {}),
			};
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			// Don't retry on timeout/abort, oversized bodies, or SSRF
			// blocks — none are transient.
			const transient =
				e.name !== "AbortError" &&
				e.name !== "BodyTooLargeError" &&
				e.name !== "SsrfBlockedError" &&
				(e as NodeJS.ErrnoException).code !== "UND_ERR_ABORTED";
			if (attempt < maxRetries && transient) {
				const delay = Math.min(1000 * 2 ** attempt, 30_000);
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			throw e;
		}
	}

	throw new Error(`Failed to fetch ${url} after ${maxRetries + 1} attempts`);
}
