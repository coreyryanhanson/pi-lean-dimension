/**
 * A3 — Retry-After parsing unit tests.
 *
 * `waitForRetry` prefers the delay-seconds form, falls back to parsing an
 * HTTP-date form, and falls through to exponential backoff when the date is
 * in the past (server clock skew / already-expired) or absent — never a
 * negative or zero delay. No recipe can reliably force a 429, so the unit
 * test is the proof.
 *
 * Also covers `redactSecretParams` — the output-channel-audit helper that
 * `fetchUrl` now uses to redact the request URL before embedding it in any
 * transport error message, so a raw query secret can never leak to agent
 * context via the transport boundary (the one layer holding the raw URL).
 * No recipe can reliably reach `fetchUrl`'s trailing "Failed to fetch…"
 * throw (every loop iteration returns or throws), so the unit test is the
 * regression guard for that exact boundary.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	waitForRetry,
	redactSecretParams,
	fetchUrl,
	_setClockForTest,
} from "../core/transport.js";
import { createServer, type Server } from "node:http";
import { deflateSync, gzipSync } from "node:zlib";

const BACKOFF = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000);

describe("waitForRetry (A3)", () => {
	it("parses the delay-seconds form", () => {
		expect(waitForRetry({ "retry-after": "5" }, 0)).toBe(5000);
	});

	it("parses the HTTP-date form", () => {
		const future = new Date(Date.now() + 7000).toUTCString();
		const delay = waitForRetry({ "retry-after": future }, 0);
		// ~7s in the future; allow clock skew within a second either way.
		expect(delay).toBeGreaterThan(5000);
		expect(delay).toBeLessThan(8000);
	});

	it("falls back to backoff for a past-dated HTTP-date", () => {
		const past = new Date(Date.now() - 10_000).toUTCString();
		expect(waitForRetry({ "retry-after": past }, 2)).toBe(BACKOFF(2));
	});

	it("falls back to backoff when Retry-After is absent", () => {
		expect(waitForRetry({}, 1)).toBe(BACKOFF(1));
	});

	it("falls back to backoff for a non-numeric, non-date value", () => {
		expect(waitForRetry({ "retry-after": "garbage" }, 3)).toBe(BACKOFF(3));
	});
});

describe("redactSecretParams (transport output-channel audit)", () => {
	it("redacts every named secret query value to ***", () => {
		const names = new Set(["apikey", "token"]);
		expect(
			redactSecretParams(
				"https://api.example.com/x?apikey=SECRET&q=hi&token=ABC",
				names,
			),
		).toBe("https://api.example.com/x?apikey=***&q=hi&token=***");
	});

	it("leaves the URL unchanged when no secret names are in play", () => {
		const url = "https://api.example.com/x?q=hi";
		expect(redactSecretParams(url, new Set(["apikey"]))).toBe(url);
	});

	it("does not touch a param that is not a declared secret", () => {
		expect(
			redactSecretParams(
				"https://api.example.com/x?q=KEEP&apikey=SECRET",
				new Set(["apikey"]),
			),
		).toBe("https://api.example.com/x?q=KEEP&apikey=***");
	});

	it("returns the URL unchanged for an unparseable URL", () => {
		const url = "not-a-url {{{";
		expect(redactSecretParams(url, new Set(["apikey"]))).toBe(url);
	});
});

// ═══════════════════════════════════════════════════════════════
// Content-Encoding decompression (gzip-happy servers)
// ═══════════════════════════════════════════════════════════════

// Open Food Facts' mod_deflate gzips JSON even when the client does not
// advertise `Accept-Encoding: gzip`; undici's raw request() does not
// auto-decompress. The transport must honor Content-Encoding or the raw
// gzip bytes reach JSON.parse. The decode path is one line inside fetchUrl,
// so the proof needs a real socket — a tiny in-process server stands in.

function listenAsync(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr && typeof addr === "object") resolve(addr.port);
			else reject(new Error("no port"));
		});
	});
}

describe("fetchUrl content-encoding handling", () => {
	it("transparently decompresses a gzip body", async () => {
		const payload = JSON.stringify({ value: [1, 2, 3] });
		const server = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				"content-encoding": "gzip",
			});
			res.end(gzipSync(Buffer.from(payload)));
		});
		const port = await listenAsync(server);
		try {
			const result = await fetchUrl(`http://127.0.0.1:${port}/gz`, {
				fresh: true,
			});
			expect(result.status).toBe(200);
			expect(JSON.parse(result.body)).toEqual({ value: [1, 2, 3] });
		} finally {
			server.close();
		}
	});

	it("transparently decompresses a zlib-wrapped deflate body", async () => {
		const payload = JSON.stringify({ ok: true });
		const server = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				"content-encoding": "deflate",
			});
			res.end(deflateSync(Buffer.from(payload)));
		});
		const port = await listenAsync(server);
		try {
			const result = await fetchUrl(`http://127.0.0.1:${port}/def`, {
				fresh: true,
			});
			expect(JSON.parse(result.body)).toEqual({ ok: true });
		} finally {
			server.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════
// Body-size ceiling — a response body past MAX_BODY_BYTES aborts the
// collect loop with BodyTooLargeError, which fetchUrl's retry logic
// classifies as non-transient (exactly one request, no retry).
// ═══════════════════════════════════════════════════════════════

describe("fetchUrl body-size ceiling", () => {
	it("throws BodyTooLargeError on an oversized body without retrying", async () => {
		let requests = 0;
		const server = createServer((_req, res) => {
			requests++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(Buffer.alloc(10 * 1024 * 1024 + 1));
		});
		const port = await listenAsync(server);
		try {
			await expect(
				fetchUrl(`http://127.0.0.1:${port}/huge`, { fresh: true }),
			).rejects.toMatchObject({ name: "BodyTooLargeError" });
			expect(requests).toBe(1);
		} finally {
			server.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Grant-based caching — a body is served from cache only when the
// server granted freshness: a time grant (Cache-Control: max-age) or a
// validator grant (ETag → revalidate-only). No TTL is ever fabricated.
// All expiry scenarios are driven by the module clock (_setClockForTest),
// never by sleeping.
// ═══════════════════════════════════════════════════════════════════

interface ResponseSpec {
	status: number;
	headers?: Record<string, string>;
	body?: string;
	/** Hold the response before sending (lets a test interleave another
	 *  fetchUrl call while this request is in flight). */
	delayMs?: number;
}

/** Start a local server whose responses are computed per request index
 *  (1-based). Tracks the number of network requests and every received
 *  If-None-Match header (undefined when absent). */
async function startCacheServer(
	respond: (
		n: number,
		ifNoneMatch: string | undefined,
		url: string | undefined,
	) => ResponseSpec,
): Promise<{
	port: number;
	requestCount: () => number;
	ifNoneMatches: (string | undefined)[];
	close: () => Promise<void>;
}> {
	let n = 0;
	const ifNoneMatches: (string | undefined)[] = [];
	const server = createServer(async (req, res) => {
		n++;
		ifNoneMatches.push(req.headers["if-none-match"]);
		const spec = respond(n, req.headers["if-none-match"], req.url);
		if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
		res.writeHead(spec.status, {
			"content-type": "application/json",
			...spec.headers,
		});
		res.end(spec.body ?? JSON.stringify({ n }));
	});
	const port = await listenAsync(server);
	return {
		port,
		requestCount: () => n,
		ifNoneMatches,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
	};
}

/** Cache-suite teardown: restore the real clock and close the server in
 *  one step, so a test can't reset one and forget the other. */
function stopCacheServer(
	srv: Awaited<ReturnType<typeof startCacheServer>>,
): Promise<void> {
	_setClockForTest(() => Date.now());
	return srv.close();
}

/** Fixed test epoch so all clock math is deterministic. */
const T0 = 1_700_000_000_000;

function atClock(offsetMs: number): void {
	_setClockForTest(() => T0 + offsetMs);
}

describe("grant-based caching", () => {
	it("max-age: second call served from cache (zero network), third after TTL expiry hits network", async () => {
		const srv = await startCacheServer((n) => ({
			status: 200,
			headers: { "cache-control": "max-age=10" },
			body: JSON.stringify({ n }),
		}));
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/max-age`;
			const r1 = await fetchUrl(url);
			expect(r1.cached).toBe(false);
			const r2 = await fetchUrl(url);
			expect(r2.cached).toBe(true);
			expect(r2.body).toBe(r1.body);
			expect(srv.requestCount()).toBe(1);
			// TTL expiry → network again.
			atClock(10_001);
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(false);
			expect(srv.requestCount()).toBe(2);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("ETag without Cache-Control: never stale; 304 reuses body (cached), 200 replaces it", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n > 1 && inm === '"v1"') {
				if (n === 2) return { status: 304, headers: { etag: '"v1"' } };
				return {
					status: 200,
					headers: { etag: '"v2"' },
					body: JSON.stringify({ n, changed: true }),
				};
			}
			return { status: 200, headers: { etag: '"v1"' } };
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/etag-only`;
			const r1 = await fetchUrl(url);
			expect(r1.cached).toBe(false);
			// Born-expired (no time grant): the hit branch never serves it, but
			// the repeat is a conditional GET answered by a 304 → body reused.
			const r2 = await fetchUrl(url);
			expect(r2.cached).toBe(true);
			expect(r2.body).toBe(r1.body);
			expect(srv.requestCount()).toBe(2);
			expect(srv.ifNoneMatches[1]).toBe('"v1"');
			// Server sends a new body → 200 replaces cache (and the ETag).
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(false);
			expect(JSON.parse(r3.body)).toEqual({ n: 3, changed: true });
			expect(srv.ifNoneMatches[2]).toBe('"v1"');
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("no cache headers, no ETag: every call hits the network, nothing stored", async () => {
		const srv = await startCacheServer((n) => ({
			status: 200,
			body: JSON.stringify({ n }),
		}));
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/bare`;
			const r1 = await fetchUrl(url);
			const r2 = await fetchUrl(url);
			const r3 = await fetchUrl(url);
			expect(r1.cached).toBe(false);
			expect(r2.cached).toBe(false);
			expect(r3.cached).toBe(false);
			expect(srv.requestCount()).toBe(3);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("no-store: never cached, never served — including no-store + ETag", async () => {
		const srv = await startCacheServer(() => ({
			status: 200,
			headers: { "cache-control": "no-store", etag: '"keep"' },
			body: JSON.stringify({ n: 1 }),
		}));
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/no-store`;
			const r1 = await fetchUrl(url);
			const r2 = await fetchUrl(url);
			expect(r1.cached).toBe(false);
			expect(r2.cached).toBe(false);
			// No If-None-Match on the repeat — nothing was stored to match from.
			expect(srv.ifNoneMatches[1]).toBeUndefined();
			expect(srv.requestCount()).toBe(2);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("no-cache + ETag: revalidate-only — every repeat is a conditional GET, 304 reuses body", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n > 1 && inm === '"nc"') return { status: 304 };
			return {
				status: 200,
				headers: { "cache-control": "no-cache", etag: '"nc"' },
			};
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/no-cache-etag`;
			const r1 = await fetchUrl(url);
			expect(r1.cached).toBe(false);
			const r2 = await fetchUrl(url);
			expect(r2.cached).toBe(true);
			expect(r2.body).toBe(r1.body);
			expect(srv.requestCount()).toBe(2);
			expect(srv.ifNoneMatches[1]).toBe('"nc"');
			// Far past any conceivable TTL — still revalidate-only, never served
			// from the hit branch without a round trip.
			atClock(3_600_000);
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(true);
			expect(srv.requestCount()).toBe(3);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it.each([
		["max-age=0", { "cache-control": "max-age=0" }],
		["bare no-cache", { "cache-control": "no-cache" }],
		["no-cache, max-age>0", { "cache-control": "no-cache, max-age=300" }],
	])(
		"%s with no ETag: not stored — every repeat is a full refetch",
		async (_name, cc) => {
			const srv = await startCacheServer(() => ({
				status: 200,
				headers: cc,
			}));
			try {
				atClock(0);
				const url = `http://127.0.0.1:${srv.port}/dead`;
				const r1 = await fetchUrl(url);
				const r2 = await fetchUrl(url);
				expect(r1.cached).toBe(false);
				expect(r2.cached).toBe(false);
				expect(srv.requestCount()).toBe(2);
				expect(srv.ifNoneMatches[1]).toBeUndefined();
			} finally {
				await stopCacheServer(srv);
			}
		},
	);

	it("no-cache, max-age>0 + ETag: revalidate-only on every repeat (RFC 7234 §5.2.2.4)", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n > 1 && inm === '"ncx"') return { status: 304 };
			return {
				status: 200,
				headers: { "cache-control": "no-cache, max-age=300", etag: '"ncx"' },
			};
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/no-cache-maxage-etag`;
			await fetchUrl(url);
			// Well within the declared max-age — must still revalidate.
			atClock(1_000);
			const r2 = await fetchUrl(url);
			expect(r2.cached).toBe(true);
			expect(srv.requestCount()).toBe(2);
			expect(srv.ifNoneMatches[1]).toBe('"ncx"');
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("max-age + ETag expired: 304 refreshes TTL from the recorded grant (not revalidate-only)", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n > 1 && inm === '"v1"') return { status: 304 };
			return {
				status: 200,
				headers: { "cache-control": "max-age=10", etag: '"v1"' },
			};
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/maxage-etag-expiry`;
			await fetchUrl(url);
			atClock(10_001); // past TTL
			const r2 = await fetchUrl(url); // conditional GET → 304
			expect(r2.cached).toBe(true);
			expect(srv.requestCount()).toBe(2);
			// The refreshed entry must carry the original max-age grant again —
			// a repeat within the new TTL is served from the hit branch with
			// zero network, proving the TTL was refreshed (not revalidate-only).
			atClock(10_500);
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(true);
			expect(srv.requestCount()).toBe(2);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("304 carrying a new max-age upgrades the grant from its own header", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n > 1 && inm === '"up"')
				return {
					status: 304,
					headers: { "cache-control": "max-age=100", etag: '"up"' },
				};
			return {
				status: 200,
				headers: { "cache-control": "max-age=10", etag: '"up"' },
			};
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/maxage-upgrade`;
			await fetchUrl(url);
			atClock(10_001); // original TTL expired
			await fetchUrl(url); // conditional GET → 304 with max-age=100
			expect(srv.requestCount()).toBe(2);
			// Still served from the hit branch well past the original TTL —
			// the 304's own max-age took over.
			atClock(50_000);
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(true);
			expect(srv.requestCount()).toBe(2);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("304 carrying no-cache keeps the refreshed entry revalidate-only", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n === 2 && inm === '"nc304"')
				return {
					status: 304,
					headers: { "cache-control": "no-cache, max-age=60" },
				};
			if (n > 2 && inm === '"nc304"') return { status: 304 }; // bare
			return {
				status: 200,
				headers: { "cache-control": "max-age=10", etag: '"nc304"' },
			};
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/maxage-to-nocache`;
			await fetchUrl(url);
			atClock(10_001); // past TTL
			const r2 = await fetchUrl(url); // conditional GET → 304 with no-cache
			expect(r2.cached).toBe(true);
			expect(srv.requestCount()).toBe(2);
			// The no-cache arm applies to the 304's own headers: the entry stays
			// born-expired → the next repeat is another conditional GET, never
			// a header hit.
			atClock(10_500);
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(true);
			expect(srv.requestCount()).toBe(3);
			expect(srv.ifNoneMatches[2]).toBe('"nc304"');
			// The no-cache grant must stick: a later bare 304 falls back to the
			// (now-updated) 0 grant, not the original store-time max-age —
			// otherwise the entry would resurrect as a header hit.
			atClock(11_000);
			const r4 = await fetchUrl(url); // bare 304
			expect(r4.cached).toBe(true);
			expect(srv.requestCount()).toBe(4);
			atClock(11_500);
			const r5 = await fetchUrl(url);
			expect(r5.cached).toBe(true);
			expect(srv.requestCount()).toBe(5); // conditional GET, not a header hit
			expect(srv.ifNoneMatches[4]).toBe('"nc304"');
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("304 carrying no-store deletes the entry instead of refreshing it", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n > 1 && inm === '"gone"')
				return { status: 304, headers: { "cache-control": "no-store" } };
			return {
				status: 200,
				headers: { "cache-control": "max-age=10", etag: '"gone"' },
			};
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/no-store-304`;
			await fetchUrl(url);
			atClock(10_001);
			const r2 = await fetchUrl(url); // 304 + no-store → entry deleted
			expect(r2.cached).toBe(true); // 304 still returns the stored body
			expect(srv.requestCount()).toBe(2);
			// Entry is gone: the next call is a plain full refetch.
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(false);
			expect(srv.requestCount()).toBe(3);
			expect(srv.ifNoneMatches[2]).toBeUndefined();
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("entry evicted while its conditional GET is in flight: the 304 still reuses the captured entry, no empty-body fall-through", async () => {
		// While a revalidation is awaited, a concurrent caller's store can
		// trigger evictCacheIfNeeded, whose sweep deletes the now-expired entry
		// under revalidation. The 304 arm must use the entry reference captured
		// at If-None-Match time — re-reading the map would fall through with an
		// empty 304 body, which the 2xx store branch would store (poisoning the
		// key with an empty body that later 304s would happily serve).
		const targetInms: (string | undefined)[] = [];
		const srv = await startCacheServer((_n, inm, url) => {
			if (url?.endsWith("/race-target")) {
				// The revalidated entry: first hit stores it (granted + ETag),
				// the repeat is the conditional GET — held 200ms so the
				// concurrent eviction fetch below completes while it's in flight.
				targetInms.push(inm);
				if (targetInms.length === 1)
					return {
						status: 200,
						headers: { "cache-control": "max-age=60", etag: '"race"' },
						body: JSON.stringify({ who: "target" }),
					};
				return { status: 304, delayMs: 200 };
			}
			// Cache fillers and the eviction catalyst: granted, no ETag.
			return { status: 200, headers: { "cache-control": "max-age=60" } };
		});
		try {
			atClock(0);
			const base = `http://127.0.0.1:${srv.port}`;
			for (let i = 0; i < 100; i++) await fetchUrl(`${base}/fill-${i}`);
			const url = `${base}/race-target`;
			await fetchUrl(url); // stores the granted + ETag entry (cache now at cap+1)
			atClock(60_001); // expire everything without sweeping yet
			// Revalidation starts: the If-None-Match read happens synchronously,
			// then the conditional GET hangs in the server's 200ms delay.
			const pending = fetchUrl(url);
			// Concurrent granted fetch → evictCacheIfNeeded sweep deletes the
			// expired entries (including the one under revalidation) while the
			// 304 is still in flight.
			await fetchUrl(`${base}/race-catalyst`);
			const r = await pending;
			// The captured entry is used: cached body served, grant refreshed.
			expect(r.cached).toBe(true);
			expect(r.status).toBe(200);
			expect(r.body).toContain("target");
			expect(targetInms[0]).toBeUndefined(); // first target hit: plain GET
			expect(targetInms[1]).toBe('"race"'); // second: conditional GET
			expect(srv.requestCount()).toBe(103);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("fresh: true skips the cache read and If-None-Match, but still stores a granted response (seed invariant)", async () => {
		const srv = await startCacheServer((n, inm) => {
			if (n > 1 && inm === '"seed"') return { status: 304 };
			return {
				status: 200,
				headers: { "cache-control": "max-age=60", etag: '"seed"' },
			};
		});
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/fresh-seed`;
			// Warm the cache, expire it, then fetch fresh — If-None-Match must
			// be suppressed and the response still re-stored.
			await fetchUrl(url, { fresh: true });
			atClock(60_001);
			const r2 = await fetchUrl(url, { fresh: true });
			expect(r2.cached).toBe(false);
			expect(srv.requestCount()).toBe(2);
			expect(srv.ifNoneMatches[1]).toBeUndefined();
			// Seeded: a non-fresh repeat is served from the cache header hit.
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(true);
			expect(srv.requestCount()).toBe(2);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("auth-bearing request: no cache read and no cache write (pinned)", async () => {
		const srv = await startCacheServer(() => ({
			status: 200,
			headers: { "cache-control": "max-age=60" },
		}));
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/auth-private`;
			const headers = { "x-api-key": "k1" };
			const r1 = await fetchUrl(url, { headers });
			const r2 = await fetchUrl(url, { headers });
			expect(r1.cached).toBe(false);
			expect(r2.cached).toBe(false);
			// A key-less caller must not be served the keyed caller's response
			// either — nothing was stored.
			const r3 = await fetchUrl(url);
			expect(r3.cached).toBe(false);
			expect(srv.requestCount()).toBe(3);
		} finally {
			await stopCacheServer(srv);
		}
	});

	it("auth-bearing request: a protocol-violating spontaneous 304 is never served the cached body", async () => {
		// If-None-Match is only sent when !hasAuth, so a compliant server can
		// never 304 a keyed request — but one that does must not hand the keyed
		// caller the body an earlier unauthenticated caller cached under the
		// same key. The 304 arm is gated on !hasAuth like every cache arm.
		const srv = await startCacheServer((n) =>
			n === 1
				? {
						status: 200,
						headers: { "cache-control": "max-age=60", etag: '"v1"' },
						body: JSON.stringify({ public: true }),
					}
				: { status: 304 },
		);
		try {
			atClock(0);
			const url = `http://127.0.0.1:${srv.port}/auth-spontaneous-304`;
			// Warm the cache with an unauthenticated caller.
			await fetchUrl(url);
			// Keyed caller gets a spontaneous 304 — must fall through, not be
			// served the cached (unauthenticated) body.
			const r2 = await fetchUrl(url, { headers: { "x-api-key": "k1" } });
			expect(r2.cached).toBe(false);
			expect(r2.body).not.toContain("public");
			expect(srv.requestCount()).toBe(2);
		} finally {
			await stopCacheServer(srv);
		}
	});
});

// ═══════════════════════════════════════════════════════════════
// fetchUrl — fallbackCharset + guardRedirects (moved from helpers.test.ts)
// ═══════════════════════════════════════════════════════════════

interface CharsetTestCtx {
	serverUrl: string;
	stop: () => Promise<void>;
	requestCounts: Map<string, number>;
}

/** Serves the latin-1 / charset-declaration / redirect-metadata routes. */
async function startCharsetServer(): Promise<CharsetTestCtx> {
	const requestCounts = new Map<string, number>();
	const server = createServer((req, res) => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);

		if (pathname === "/api/latin1-no-charset") {
			// ISO-8859-1 bytes for áéíóú, served with NO charset parameter —
			// the transport must fall back to the caller's fallbackCharset.
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(Buffer.from([0xe1, 0xe9, 0xed, 0xf3, 0xfa]));
			return;
		}

		if (pathname === "/api/utf8-with-charset") {
			// Real UTF-8 bytes for áéíóú, served WITH charset=utf-8 — the
			// header charset must win even if a fallbackCharset is supplied.
			res.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
			});
			res.end(Buffer.from("áéíóú", "utf-8"));
			return;
		}

		// 302 redirect to the cloud metadata endpoint (guardRedirects). The
		// initial URL is on 127.0.0.1 — fetchUrl does NOT ssrf-check the
		// initial URL (paginate owns that), only redirect targets.
		if (pathname === "/redirect-to-metadata") {
			res.writeHead(302, {
				Location: "http://169.254.169.254/latest/meta-data/",
			});
			res.end();
			return;
		}

		res.writeHead(404);
		res.end();
	});
	const port = await listenAsync(server);
	return {
		serverUrl: `http://127.0.0.1:${port}`,
		requestCounts,
		stop: () =>
			new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
	};
}

describe("fetchUrl — fallbackCharset", () => {
	let ctx: CharsetTestCtx;

	beforeAll(async () => {
		ctx = await startCharsetServer();
	});
	afterAll(async () => {
		await ctx.stop();
	});

	it("falls back to fallbackCharset when the response omits a charset", async () => {
		// Server serves ISO-8859-1 bytes with no charset parameter.
		const { body } = await fetchUrl(`${ctx.serverUrl}/api/latin1-no-charset`, {
			fallbackCharset: "iso-8859-1",
			fresh: true,
		});
		expect(body).toBe("áéíóú");
	});

	it("uses utf-8 by default when no fallbackCharset is supplied", async () => {
		const { body } = await fetchUrl(`${ctx.serverUrl}/api/latin1-no-charset`, {
			fresh: true,
		});
		expect(body).not.toBe("áéíóú");
		expect(body).toBe("�����");
	});

	it("header charset wins over fallbackCharset", async () => {
		// Server declares charset=utf-8; supplying a latin-1 fallback must
		// NOT override it — the header charset always wins.
		const { body } = await fetchUrl(`${ctx.serverUrl}/api/utf8-with-charset`, {
			fallbackCharset: "iso-8859-1",
			fresh: true,
		});
		expect(body).toBe("áéíóú");
	});
});

describe("fetchUrl — guardRedirects (M3)", () => {
	let ctx: CharsetTestCtx;

	beforeAll(async () => {
		ctx = await startCharsetServer();
	});

	afterAll(async () => {
		await ctx.stop();
	});

	it("blocks a 302 redirect to the cloud metadata endpoint", async () => {
		// fetchUrl does NOT ssrf-check the initial URL (paginate owns that),
		// so hitting the 127.0.0.1 test server is fine. The redirect target
		// (169.254.169.254) must be blocked before it is fetched.
		const before = ctx.requestCounts.get("/redirect-to-metadata") ?? 0;
		await expect(
			fetchUrl(`${ctx.serverUrl}/redirect-to-metadata`, {
				guardRedirects: true,
			}),
		).rejects.toThrow(/Redirect to blocked host/i);

		// The redirect endpoint was hit exactly once (the SSRF block is not
		// transient, so fetchUrl must not retry).
		const after = ctx.requestCounts.get("/redirect-to-metadata") ?? 0;
		expect(after - before).toBe(1);
	});
});
