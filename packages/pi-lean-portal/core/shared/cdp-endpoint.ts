/**
 * CDP endpoint discovery — finds the DevTools Protocol endpoint of a
 * Chromium browser launched with `--remote-debugging-port=0`.
 *
 * Used by the chromium plugin's `getCdpEndpoint()` (Mode A in
 * `pi-lean-host`'s BrowserGym bridge — see
 * `packages/pi-lean-host/docs/cdp-endpoint-spike.md`).
 *
 * Mechanism (spike-confirmed on Linux):
 *   1. Chromium is launched with `--remote-debugging-port=0`; the OS
 *      assigns a free port.
 *   2. `ss -tlnp` lists listening TCP sockets with process info.
 *   3. Lines whose `users:` field matches one of the candidate process
 *      names are scanned for a `127.0.0.1:<port>` (or `[::1]:<port>`)
 *      local address.
 *   4. The first match wins; the endpoint is `http://127.0.0.1:<port>`.
 *   5. If `ss` is unavailable or finds nothing, fall back to a fixed
 *      port read from the `CDP_PORT` env var (useful on macOS / Windows
 *      / containers without `ss`, and for parallel CI cells that need
 *      distinct fixed ports).
 *
 * Why not `browser.process()`? Playwright Node 1.61 does not expose it
 * (see spike findings), so the PID is not directly available and port
 * discovery must go through an external process-list / socket-scan
 * mechanism.
 */

import { execFileSync } from "node:child_process";

// ─── Types ────────────────────────────────────────────────────────

/** Options for `resolveCdpEndpoint`. */
export interface ResolveCdpEndpointOptions {
	/**
	 * Candidate process-name fragments to match in `ss` output, tried in
	 * order within a single `ss` pass (e.g. `["chrome-headless",
	 * "chromium"]`). The first line whose `users:` field contains any
	 * candidate and has a loopback port wins. Avoids re-scanning `ss`
	 * once per candidate.
	 */
	processNames: readonly string[];
	/** Max total time to poll `ss` for the port, in ms. Default 15_000. */
	scanTimeoutMs?: number;
	/** Poll interval in ms. Default 500. */
	pollIntervalMs?: number;
	/**
	 * Override the `CDP_PORT` env var source (testing hook).
	 * Defaults to `process.env.CDP_PORT`.
	 */
	envPort?: string | undefined;
	/**
	 * Override the `ss` invoker (testing hook).
	 * Defaults to running `ss -tlnp` via `child_process.execFileSync`.
	 * Returns stdout as a string.
	 */
	runSs?: () => string;
	/**
	 * Override the sleep between polls (testing hook).
	 * Defaults to a real `setTimeout`. Should resolve immediately in tests.
	 */
	sleep?: (ms: number) => Promise<void>;
}

// ─── Defaults ──────────────────────────────────────────────────────

const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

// ─── Public API ────────────────────────────────────────────────────

/**
 * Resolve a CDP endpoint for a Chromium launched with
 * `--remote-debugging-port=0`.
 *
 * Strategy:
 *   1. If `CDP_PORT` (or `envPort`) is set and numeric, return
 *      `http://127.0.0.1:<port>` immediately — fixed-port mode for
 *      non-Linux / parallel-CI use.
 *   2. Otherwise poll `ss -tlnp` for a listening socket whose process
 *      name matches any of `processNames`, extracting the port from the
 *      first matching `127.0.0.1:<port>` / `[::1]:<port>` line. Polls
 *      until `scanTimeoutMs`.
 *
 * Returns `http://127.0.0.1:<port>` on success, or `null` if no endpoint
 * could be discovered within the timeout.
 */
export async function resolveCdpEndpoint(
	opts: ResolveCdpEndpointOptions,
): Promise<string | null> {
	// 1. Fixed-port env override (highest priority — explicit user intent).
	const envEndpoint = cdpEndpointFromEnv(opts.envPort);
	if (envEndpoint) return envEndpoint;

	// 2. ss -tlnp scan.
	const scanTimeoutMs = opts.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const sleep = opts.sleep ?? defaultSleep;
	const runSs = opts.runSs ?? defaultRunSs;

	const deadline = Date.now() + scanTimeoutMs;
	do {
		let ssOutput = "";
		try {
			ssOutput = runSs();
		} catch {
			// `ss` unavailable (non-Linux) or spawn error — fall through to sleep+retry.
			ssOutput = "";
		}
		const endpoint = scanSsForEndpoint(ssOutput, opts.processNames);
		if (endpoint) return endpoint;
		await sleep(pollIntervalMs);
	} while (Date.now() < deadline);

	return null;
}

/**
 * Read a `CDP_PORT`-style env value and return the corresponding
 * `http://127.0.0.1:<port>` endpoint, or `null` if unset / non-numeric.
 * Shared helper for `resolveCdpEndpoint` to reuse the validation
 * logic.
 */
function cdpEndpointFromEnv(
	envPort: string | undefined = process.env.CDP_PORT,
): string | null {
	if (envPort && /^\d+$/.test(envPort.trim())) {
		return `http://127.0.0.1:${envPort.trim()}`;
	}
	return null;
}

// ─── Internals (exported for unit testing) ──────────────────────────

/**
 * Parse `ss -tlnp` output and return the first CDP endpoint matching
 * any of the candidate process-name fragments. Returns `null` if no
 * match found.
 *
 * `ss -tlnp` line shape (Linux iproute2):
 *   ```
 *   State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
 *   LISTEN  0       4096    127.0.0.1:9222      0.0.0.0:*          users:(("chrome-headless",pid=1234,fd=23))
 *   ```
 *
 * For each line, the candidates are checked in order; the first
 * candidate that appears in the line AND has a loopback port wins. This
 * keeps a single `ss` pass sufficient for multi-name matching (e.g.
 * `chrome-headless` vs system `chromium`).
 *
 * Match rules:
 *   - The `Local Address:Port` field looks like `127.0.0.1:<digits>` or
 *     `[::1]:<digits>` (IPv6 loopback), AND
 *   - The line contains the candidate process-name fragment
 *     (case-sensitive — `ss` reports the actual executable name).
 */
export function scanSsForEndpoint(
	ssOutput: string,
	processNames: readonly string[],
): string | null {
	// Loopback host patterns: 127.0.0.1:<port> or [::1]:<port>
	const loopbackPortRe = /(?:127\.0\.0\.1|\[::1\]):(\d+)/;
	for (const line of ssOutput.split("\n")) {
		// Skip lines with no loopback port early — cheap pre-filter.
		const portMatch = line.match(loopbackPortRe);
		if (!portMatch || portMatch[1] === undefined) continue;
		// Then check whether any candidate process name is on this line.
		if (!processNames.some((name) => line.includes(name))) continue;
		const port = portMatch[1];
		// Sanity: valid TCP port range.
		const portNum = Number.parseInt(port, 10);
		if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) continue;
		return `http://127.0.0.1:${port}`;
	}
	return null;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRunSs(): string {
	// Spawn `ss -tlnp`. On platforms without `ss` (macOS / Windows / minimal
	// containers) the spawn throws and we return "" — callers fall back to
	// the `CDP_PORT` env var path.
	try {
		return execFileSync("ss", ["-tlnp"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
	} catch {
		return "";
	}
}
