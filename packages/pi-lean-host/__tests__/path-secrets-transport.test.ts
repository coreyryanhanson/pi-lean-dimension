/**
 * Transport-level tests for path-token secrets — real local
 * servers, real guarded-redirect loop.
 *
 * Covers:
 *  - hasPathSecret broadens the hasAuth gate: cache-skip for a
 *    path-secret-only request (no non-accept headers to trip hasAuthHeaders)
 *  - cross-domain redirect hops: the token is redacted out of the hop URL
 *    via the caller-built closure (raw + both hex forms in a Location echo)
 *  - same-host Location echoes KEEP the token (matching the
 *    resolve-against-hopUrl logic)
 *
 * The SSRF guard is stubbed to allow the loopback test servers through —
 * only the guard is faked; the redirect loop, header stripping, and the
 * closure wiring are the real transport code.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../core/ssrf-guard.js", () => ({
	ssrfGuard: () => ({ ok: true }),
}));

import { fetchUrl, redactSecretPathValues } from "../core/transport.js";
import { startTestServer } from "../../pi-lean-portal/__tests__/helpers/test-server.js";

const TOKEN = "s3cr3t:PATH-tok";
const TOKEN_ENC_LOWER = encodeURIComponent(TOKEN).replace(/%../g, (s) =>
	s.toLowerCase(),
);

const receivedA: string[] = [];
const receivedB: string[] = [];
const counts = new Map<string, number>();

const handlerB = (req: IncomingMessage, res: ServerResponse) => {
	receivedB.push(req.url ?? "/");
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true, at: "B" }));
};

let serverA: { url: string; stop: () => Promise<void> };
let serverB: { url: string; stop: () => Promise<void> };

beforeAll(async () => {
	serverB = await startTestServer(handlerB);
	const b = serverB.url;
	const handlerA = (req: IncomingMessage, res: ServerResponse) => {
		receivedA.push(req.url ?? "/");
		const url = new URL(req.url ?? "/", "http://localhost");
		// Cache counter endpoint.
		if (url.pathname.startsWith("/count/")) {
			const k = url.pathname;
			const n = (counts.get(k) ?? 0) + 1;
			counts.set(k, n);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ count: n }));
			return;
		}
		// Cross-domain redirects (B is a different host:port → cross-domain).
		if (url.pathname.endsWith("/redirect-clean")) {
			res.writeHead(302, { Location: `${b}/other` });
			res.end();
			return;
		}
		if (url.pathname.endsWith("/redirect-echo")) {
			// A Location that echoes the token RAW on the other host.
			res.writeHead(302, { Location: `${b}/echo/${TOKEN}/x` });
			res.end();
			return;
		}
		if (url.pathname.endsWith("/redirect-echo-lower")) {
			// A Location that echoes the token in its lowercase-hex form.
			res.writeHead(302, { Location: `${b}/echo/${TOKEN_ENC_LOWER}/x` });
			res.end();
			return;
		}
		// Same-host echo: the token must survive (no redaction on same-host hops).
		if (url.pathname.endsWith("/redirect-same")) {
			res.writeHead(302, {
				Location: `http://${req.headers.host}/auth${TOKEN}/final`,
			});
			res.end();
			return;
		}
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	};
	serverA = await startTestServer(handlerA);
});

afterAll(async () => {
	await serverA.stop();
	await serverB.stop();
});

function redactor(u: string): string {
	return redactSecretPathValues(u, [TOKEN]);
}

describe("fetchUrl — hasPathSecret gate", () => {
	it("a path-secret request skips the cache — each call reaches the server", async () => {
		const uri = `${serverA.url}/count/pathsecret-${Date.now()}`;
		const r1 = JSON.parse(
			(await fetchUrl(uri, { hasPathSecret: true })).body,
		) as { count: number };
		const r2 = JSON.parse(
			(await fetchUrl(uri, { hasPathSecret: true })).body,
		) as { count: number };
		expect(r2.count).toBe(r1.count + 1);
		// Control: same URL without the flag IS cached.
		const c1 = JSON.parse((await fetchUrl(uri, { fresh: false })).body) as {
			count: number;
		};
		const c2 = JSON.parse((await fetchUrl(uri, { fresh: false })).body) as {
			count: number;
		};
		expect(c2.count).toBe(c1.count);
	});
});

describe("redactSecretPathValues — length guards", () => {
	it("skips empty values without corrupting the URL", () => {
		// replaceAll("") would insert *** between every character.
		expect(redactSecretPathValues("/auth123/get", [""])).toBe("/auth123/get");
	});

	it("skips 1-char values with a console.warn (URL channel asymmetry)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// A 1-char blanket replace would corrupt unrelated path text
		// (/things/1234/x → /things/***234/x) for negligible security gain.
		expect(redactSecretPathValues("/things/1234/x", ["1"])).toBe(
			"/things/1234/x",
		);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("redacts a multi-char value in raw, %3A, and lowercase-hex %3a forms", () => {
		const v = "12:AB";
		const enc = encodeURIComponent(v); // 12%3AAB (fillPathTemplate form)
		// Lowercase-hex form — hex digits only
		// (encodeURIComponent(v).replace(/%../g, s => s.toLowerCase())).
		const lower = enc.replace(/%../g, (s) => s.toLowerCase()); // 12%3aAB
		const url = `/auth${v}/x?a=${enc}&b=${lower}`;
		const out = redactSecretPathValues(url, [v]);
		expect(out).toBe("/auth***/x?a=***&b=***");
	});
});

describe("guarded-redirect hop redaction (path token)", () => {
	it("a cross-domain redirect does not carry the token in its path", async () => {
		await fetchUrl(`${serverA.url}/auth${TOKEN}/redirect-clean`, {
			hasPathSecret: true,
			redactPathSecret: redactor,
		});
		expect(receivedB.at(-1)).toBe("/other");
	});

	it("a cross-domain Location echo of the RAW token is stripped before the next hop", async () => {
		await fetchUrl(`${serverA.url}/auth${TOKEN}/redirect-echo`, {
			hasPathSecret: true,
			redactPathSecret: redactor,
		});
		const seen = receivedB.at(-1)!;
		expect(seen).not.toContain(TOKEN);
		expect(seen).toBe("/echo/***/x");
	});

	it("a cross-domain Location echo in lowercase-hex (%3a) form is stripped too", async () => {
		await fetchUrl(`${serverA.url}/auth${TOKEN}/redirect-echo-lower`, {
			hasPathSecret: true,
			redactPathSecret: redactor,
		});
		const seen = receivedB.at(-1)!;
		expect(seen).not.toContain(TOKEN_ENC_LOWER);
		expect(seen).toBe("/echo/***/x");
	});

	it("same-host Location echoes KEEP the token (no redaction on same-host hops)", async () => {
		await fetchUrl(`${serverA.url}/auth${TOKEN}/redirect-same`, {
			hasPathSecret: true,
			redactPathSecret: redactor,
		});
		expect(receivedA.at(-1)).toBe(`/auth${TOKEN}/final`);
	});
});
