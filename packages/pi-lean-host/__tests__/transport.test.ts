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

import { describe, it, expect } from "vitest";
import {
	waitForRetry,
	redactSecretParams,
	fetchUrl,
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
