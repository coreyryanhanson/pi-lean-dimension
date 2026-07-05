/**
 * CDP endpoint discovery tests — verifies `resolveCdpEndpoint` and
 * `scanSsForEndpoint` parsing logic. Pure unit tests, no browser,
 * no real `ss` spawn (the `runSs` and `sleep` hooks are stubbed).
 */

import { describe, it, expect } from "vitest";
import {
	resolveCdpEndpoint,
	scanSsForEndpoint,
	cdpEndpointFromEnv,
} from "../core/shared/cdp-endpoint.js";

// ─── `ss -tlnp` output fixture ─────────────────────────────────────

/** Realistic `ss -tlnp` output with a chrome-headless listener on 9222. */
const SS_WITH_CHROME = [
	"State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process",
	'LISTEN  0       4096    0.0.0.0:22           0.0.0.0:*          users:(("sshd",pid=1,fd=3))',
	'LISTEN  0       4096    127.0.0.1:9222       0.0.0.0:*          users:(("chrome-headless",pid=1234,fd=23))',
	'LISTEN  0       4096    127.0.0.1:5432       0.0.0.0:*          users:(("postgres",pid=5678,fd=12))',
].join("\n");

/** `ss` output with chromium (system chromium) on IPv6 loopback. */
const SS_WITH_CHROMIUM_IPV6 = [
	"State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process",
	'LISTEN  0       4096    [::1]:9333           [::]:*             users:(("chromium",pid=1234,fd=23))',
].join("\n");

/** `ss` output with no chrome/chromium listener. */
const SS_WITHOUT_CHROME = [
	"State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process",
	'LISTEN  0       4096    0.0.0.0:22           0.0.0.0:*          users:(("sshd",pid=1,fd=3))',
].join("\n");

// ─── scanSsForEndpoint ─────────────────────────────────────────────

describe("scanSsForEndpoint", () => {
	it("finds the chrome-headless loopback port", () => {
		expect(scanSsForEndpoint(SS_WITH_CHROME, ["chrome-headless"])).toBe(
			"http://127.0.0.1:9222",
		);
	});

	it("finds chromium on IPv6 loopback ([::1])", () => {
		expect(scanSsForEndpoint(SS_WITH_CHROMIUM_IPV6, ["chromium"])).toBe(
			"http://127.0.0.1:9333",
		);
	});

	it("matches either of multiple candidates in one pass", () => {
		// One ss output with chromium (not chrome-headless); passing both
		// names must still find it on the single scan.
		expect(
			scanSsForEndpoint(SS_WITH_CHROMIUM_IPV6, ["chrome-headless", "chromium"]),
		).toBe("http://127.0.0.1:9333");
		// And the reverse: chrome-headless in output, both names supplied.
		expect(
			scanSsForEndpoint(SS_WITH_CHROME, ["chrome-headless", "chromium"]),
		).toBe("http://127.0.0.1:9222");
	});

	it("returns null when no candidate name matches", () => {
		expect(scanSsForEndpoint(SS_WITH_CHROME, ["firefox"])).toBeNull();
	});

	it("returns null when process name matches but no loopback port", () => {
		// Construct a line where the process name matches but the address
		// is 0.0.0.0 (not loopback) — should be skipped.
		const ss = [
			'LISTEN  0       4096    0.0.0.0:9222       0.0.0.0:*          users:(("chrome-headless",pid=1234,fd=23))',
		].join("\n");
		expect(scanSsForEndpoint(ss, ["chrome-headless"])).toBeNull();
	});

	it("returns null on empty output", () => {
		expect(scanSsForEndpoint("", ["chrome-headless"])).toBeNull();
	});

	it("returns null when candidates list is empty", () => {
		expect(scanSsForEndpoint(SS_WITH_CHROME, [])).toBeNull();
	});

	it("skips lines where the candidate appears but no loopback port is present", () => {
		// A postgres row whose `users:` field doesn't contain the candidate.
		const ss = [
			'LISTEN  0       4096    127.0.0.1:5432       0.0.0.0:*          users:(("postgres",pid=1,fd=3))',
		].join("\n");
		expect(scanSsForEndpoint(ss, ["chrome-headless"])).toBeNull();
	});

	it("rejects out-of-range ports (65536)", () => {
		const ss = [
			'LISTEN  0       4096    127.0.0.1:65536      0.0.0.0:*          users:(("chrome-headless",pid=1234,fd=23))',
		].join("\n");
		expect(scanSsForEndpoint(ss, ["chrome-headless"])).toBeNull();
	});
});

// ─── cdpEndpointFromEnv ────────────────────────────────────────────

describe("cdpEndpointFromEnv", () => {
	it("returns the endpoint for a numeric CDP_PORT", () => {
		expect(cdpEndpointFromEnv("9222")).toBe("http://127.0.0.1:9222");
	});

	it("trims whitespace", () => {
		expect(cdpEndpointFromEnv("  9222  ")).toBe("http://127.0.0.1:9222");
	});

	it("returns null for non-numeric values", () => {
		expect(cdpEndpointFromEnv("abc")).toBeNull();
		expect(cdpEndpointFromEnv("")).toBeNull();
		expect(cdpEndpointFromEnv(undefined)).toBeNull();
	});

	it("rejects values with trailing junk", () => {
		expect(cdpEndpointFromEnv("9222abc")).toBeNull();
	});
});

// ─── resolveCdpEndpoint ────────────────────────────────────────────

describe("resolveCdpEndpoint", () => {
	it("prefers CDP_PORT env over ss scan", async () => {
		// `runSs` would throw if called — but env path wins, so it never runs.
		const runSs = (): string => {
			throw new Error("ss should not be called when CDP_PORT is set");
		};
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chrome-headless"],
			envPort: "9222",
			runSs,
		});
		expect(endpoint).toBe("http://127.0.0.1:9222");
	});

	it("falls back to ss scan when CDP_PORT is unset", async () => {
		const runSs = (): string => SS_WITH_CHROME;
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chrome-headless"],
			envPort: undefined,
			runSs,
			sleep: async () => {},
		});
		expect(endpoint).toBe("http://127.0.0.1:9222");
	});

	it("finds the second candidate in a single ss pass (no double-poll)", async () => {
		// ss output has `chromium` (not `chrome-headless`); both names are
		// supplied. The scan must succeed on the first poll — proving the
		// candidates are checked within one pass rather than sequentially
		// with a 15s gap.
		let ssCalls = 0;
		const runSs = (): string => {
			ssCalls++;
			return SS_WITH_CHROMIUM_IPV6;
		};
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chrome-headless", "chromium"],
			envPort: undefined,
			runSs,
			sleep: async () => {},
		});
		expect(endpoint).toBe("http://127.0.0.1:9333");
		expect(ssCalls).toBe(1);
	});

	it("polls until the port shows up", async () => {
		// First two calls return empty; third returns the chrome listener.
		let calls = 0;
		const runSs = (): string => {
			calls++;
			if (calls < 3) return SS_WITHOUT_CHROME;
			return SS_WITH_CHROME;
		};
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chrome-headless"],
			envPort: undefined,
			runSs,
			sleep: async () => {},
			pollIntervalMs: 1,
			scanTimeoutMs: 10_000,
		});
		expect(endpoint).toBe("http://127.0.0.1:9222");
		expect(calls).toBe(3);
	});

	it("returns null when ss finds nothing within the timeout", async () => {
		const runSs = (): string => SS_WITHOUT_CHROME;
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chrome-headless"],
			envPort: undefined,
			runSs,
			// sleep advances virtual time past the deadline immediately
			sleep: async () => {},
			scanTimeoutMs: 0, // zero timeout → at most one scan attempt
		});
		expect(endpoint).toBeNull();
	});

	it("returns null when runSs throws and no env port is set", async () => {
		const runSs = (): string => {
			throw new Error("ss: command not found");
		};
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chrome-headless"],
			envPort: undefined,
			runSs,
			sleep: async () => {},
			scanTimeoutMs: 0,
		});
		expect(endpoint).toBeNull();
	});

	it("handles IPv6 loopback match from ss scan", async () => {
		const runSs = (): string => SS_WITH_CHROMIUM_IPV6;
		const endpoint = await resolveCdpEndpoint({
			processNames: ["chromium"],
			envPort: undefined,
			runSs,
			sleep: async () => {},
		});
		expect(endpoint).toBe("http://127.0.0.1:9333");
	});
});
