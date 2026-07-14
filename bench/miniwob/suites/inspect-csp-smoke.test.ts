/**
 * `browser-inspect` + `browser-scroll` CSP-strict smoke — generic
 * stealth-backend regression net.
 *
 * The sibling `inspect-eval-smoke.test.ts` runs the EXTRACTOR_SCRIPT
 * against MiniWoB++ task pages, which are benign HTML with **no
 * Content-Security-Policy**. That is why it missed this class of bug:
 * the failure only manifests on CSP-strict sites (e.g. sites that
 * forbid `unsafe-eval`).
 *
 * Root cause: some patched-Firefox stealth binaries route
 * `page.evaluate` through `eval()` in the page's *main* world (a
 * stealth measure that kills Juggler's isolated-world debugger
 * signature). The page's CSP then applies, so `page.evaluate` fails.
 *
 * The fixes:
 *  - `_csp_safe_readonly_via_init_script = True` → `do_evaluate(read_only=True)`
 *    reads EXTRACTOR_SCRIPT result from a `<meta>` tag populated by a
 *    CSP-free `context.add_init_script` (isolated world).
 *  - `_scroll_via_wheel = True` → `do_scroll` uses `page.mouse.wheel`.
 *
 * Discovers every user-managed stealth backend under
 * `~/.pi/agent/pi-lean-portal/user-backends/` and runs both smokes
 * against each. Auto-skips per-backend when its venv isn't installed.
 *
 * Run: npx vitest run bench/miniwob/suites/inspect-csp-smoke.test.ts
 *
 * @module
 */

import { expect, beforeAll, afterAll } from "vitest";
import { PythonPluginAdapter } from "../../../packages/pi-lean-portal/backends/python-adapter.js";
import type { BrowserPlugin } from "../../../packages/pi-lean-portal/core/plugin-api.js";
import {
	EXTRACTOR_SCRIPT,
	type ExtractResult,
} from "../../../packages/pi-lean-portal/core/shared/dom-extractor.js";
import {
	probeUserBackend,
	discoverUserBackends,
	userBackendsDir,
} from "../../../packages/pi-lean-portal/__tests__/helpers/probe-user-backend.js";
import {
	startTestServer,
	type TestServer,
} from "../../../packages/pi-lean-portal/__tests__/helpers/test-server.js";
import { registerBackendSuite } from "./inspect-smoke-harness.js";

// ─── CSP-strict fixtures ──────────────────────────────────────────

const CSP_STRICT_HTML = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data:;">
<title>CSP Smoke Forum</title>
<style>body{display:block}h1{color:#333}</style>
</head>
<body>
  <h1>CSP Smoke Forum</h1>
  <h2>Hot Posts</h2>
  <p>First post about local models running on consumer GPUs.</p>
  <p>Second post about quantization techniques for large models.</p>
  <a href="/p1">Post one</a>
  <a href="/p2">Post two</a>
  <img alt="diagram of gpu memory layout" src="data:image/svg+xml,%3Csvg/%3E">
  <button>Upvote</button>
  <button>Comments</button>
  <input type="text" placeholder="Search the forum">
</body></html>`;

const CSP_STRICT_SCROLL_HTML = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data:;">
<title>CSP Scroll Test</title>
<style>body{display:block}h1{color:#333}</style>
</head>
<body>
  <h1>CSP Scroll Test</h1>
${Array.from({ length: 50 }, (_, i) => `<p>Paragraph ${i + 1}: content to make the page scrollable.</p>`).join("\n")}
  <p id="bottom-marker">You reached the bottom!</p>
</body></html>`;

// ─── Shared HTTP server (file-level lifecycle) ────────────────────

let testServer: TestServer | undefined;
let baseUrl = "";
let cspScrollUrl = "";

beforeAll(async () => {
	testServer = await startTestServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(
			url.pathname === "/csp-scroll" ? CSP_STRICT_SCROLL_HTML : CSP_STRICT_HTML,
		);
	});
	baseUrl = testServer.url;
	cspScrollUrl = `${testServer.url}/csp-scroll`;
});

afterAll(async () => {
	await testServer?.stop().catch(() => {});
});

// ─── Test bodies ──────────────────────────────────────────────────

async function runCspScrollSmoke(plugin: BrowserPlugin, url: string) {
	const taskId = "csp-scroll-smoke";
	const nav = await plugin.navigate(url, taskId, 30_000);
	expect(
		nav.success,
		`navigate to CSP-scroll page failed: ${nav.error ?? ""}`,
	).toBe(true);
	const down = await plugin.scroll(taskId, "down");
	expect(
		down.success,
		`scroll down on CSP-strict page failed: ${down.error ?? ""}`,
	).toBe(true);
	const up = await plugin.scroll(taskId, "up");
	expect(
		up.success,
		`scroll up on CSP-strict page failed: ${up.error ?? ""}`,
	).toBe(true);
}

async function runCspSmoke(plugin: BrowserPlugin, url: string) {
	const taskId = "csp-smoke";
	const nav = await plugin.navigate(url, taskId, 30_000);
	expect(nav.success, `navigate failed: ${nav.error ?? ""}`).toBe(true);
	expect(nav.elementCount).toBeGreaterThan(0);
	const evalResult = await plugin.evaluate(taskId, EXTRACTOR_SCRIPT, true);
	expect(
		evalResult.success,
		`evaluate EXTRACTOR_SCRIPT failed on CSP-strict page: ${evalResult.error ?? ""}`,
	).toBe(true);
	const rawJson =
		typeof evalResult.result === "string"
			? evalResult.result
			: JSON.stringify(evalResult.result);
	let parsed: ExtractResult;
	try {
		parsed = JSON.parse(rawJson) as ExtractResult;
	} catch {
		throw new Error(
			`EXTRACTOR_SCRIPT returned unparseable JSON: ${rawJson.slice(0, 200)}`,
		);
	}
	expect(parsed.title, "ExtractResult.title missing").toBe("CSP Smoke Forum");
	expect(parsed.headings.length, "headings empty").toBeGreaterThan(0);
	expect(parsed.paragraphs.length, "paragraphs empty").toBeGreaterThan(0);
	expect(parsed.links.length, "links empty").toBeGreaterThan(0);
	expect(parsed.images.length, "images empty").toBeGreaterThan(0);
	expect(parsed.interactive.length, "interactive empty").toBeGreaterThan(0);
}

// ─── Stealth-backend discovery ────────────────────────────────────

const ensureBaseUrl = () => Promise.resolve(baseUrl);

for (const name of discoverUserBackends(userBackendsDir())) {
	const PROBE = probeUserBackend(name);
	registerBackendSuite(
		"inspect-csp-smoke",
		{
			name,
			available: PROBE.available,
			missingReason: PROBE.reason ?? "user-backend not installed",
			createPlugin: () =>
				new PythonPluginAdapter(name, {
					bridgeScript: PROBE.bridgePath,
					pythonPath: PROBE.venvPython,
					capabilities: {
						supportsFullPageScreenshot: true,
						supportsJavaScriptEvaluate: true,
					},
				}),
		},
		ensureBaseUrl,
		[
			{
				label: "EXTRACTOR_SCRIPT succeeds on a CSP-strict page",
				run: (p) => runCspSmoke(p, baseUrl),
			},
			{
				label: "scrolls on a CSP-strict page",
				run: (p) => runCspScrollSmoke(p, cspScrollUrl),
			},
		],
		120_000,
	);
}
