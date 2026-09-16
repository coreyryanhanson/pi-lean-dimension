/**
 * ssrfGuard (core/ssrf-guard.ts) unit tests — consolidated here from
 * helpers.test.ts and smoke.test.ts. Pure function: no server, no fixtures.
 */

import { describe, it, expect } from "vitest";
import { ssrfGuard } from "../core/ssrf-guard.js";

function expectRejected(raw: string): void {
	const result = ssrfGuard(raw);
	expect(result.ok).toBe(false);
	const r = result as { ok: false; reason: string };
	expect(r.reason).toBeTruthy();
}

describe("ssrfGuard — IPv4-mapped IPv6 (M1)", () => {
	it("blocks IPv4-mapped loopback in hex form", () => {
		// Node renders http://[::ffff:127.0.0.1]/ as "[::ffff:7f00:1]" —
		// the old decimal "::ffff:127" check never matched this.
		expect(ssrfGuard("http://[::ffff:127.0.0.1]/").ok).toBe(false);
	});

	it("blocks IPv4-mapped private + metadata ranges", () => {
		expect(ssrfGuard("http://[::ffff:10.0.0.1]/").ok).toBe(false);
		expect(ssrfGuard("http://[::ffff:192.168.1.1]/").ok).toBe(false);
		expect(ssrfGuard("http://[::ffff:169.254.169.254]/").ok).toBe(false);
	});

	it("allows public hostnames", () => {
		expect(ssrfGuard("https://api.example.com/v1/foo").ok).toBe(true);
		expect(ssrfGuard("https://apidatos.boe.es/v1/diario/20260717").ok).toBe(true);
	});
});

describe("ssrfGuard — baseline blocks", () => {
	it("rejects AWS metadata endpoint with the host named in the reason", () => {
		const result = ssrfGuard("http://169.254.169.254/latest/meta-data/");
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toContain(
			"169.254.169.254",
		);
	});

	it("rejects private IP 10.x.x.x with an internal-network reason", () => {
		const result = ssrfGuard("http://10.0.0.1/admin");
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toContain(
			"internal network",
		);
	});

	it("still blocks plain IPv4 private/metadata/loopback", () => {
		expect(ssrfGuard("http://127.0.0.1/").ok).toBe(false);
		expect(ssrfGuard("http://10.0.0.1/").ok).toBe(false);
		expect(ssrfGuard("http://169.254.169.254/").ok).toBe(false);
		expect(ssrfGuard("http://192.168.1.1/").ok).toBe(false);
	});

	it("rejects any 127.0.0.0/8 loopback (not just .1)", () => {
		expectRejected("http://127.0.0.2/");
		expectRejected("http://127.255.255.254/");
	});

	it("rejects link-local 169.254.0.0/16 (not just the metadata IP)", () => {
		expectRejected("http://169.254.169.253/");
	});

	it("rejects IPv6 loopback ::1 exactly", () => {
		expectRejected("http://[::1]/");
	});

	it("allows public IPv6 that merely contains ::1 mid-string", () => {
		expect(ssrfGuard("http://[2001:db8::1:2:3]/").ok).toBe(true);
	});

	it("allows public IPv6 that merely contains ::ffff: mid-string", () => {
		expect(ssrfGuard("http://[2001:db8::ffff:1]/").ok).toBe(true);
	});

	it("rejects IPv6 link-local fe80::/10 and unique-local fc00::/7", () => {
		expectRejected("http://[fe80::1]/");
		expectRejected("http://[febf::1]/");
		expectRejected("http://[fc00::1]/");
		expectRejected("http://[fd12:3456::1]/");
	});

	it("rejects metadata.google.internal", () => {
		expectRejected("http://metadata.google.internal/");
	});

	it("rejects malformed URL", () => {
		const result = ssrfGuard("not a url at all");
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toBe(
			"Malformed URL",
		);
	});
});
