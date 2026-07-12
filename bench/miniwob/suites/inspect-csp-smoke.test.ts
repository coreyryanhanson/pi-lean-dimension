/**
 * `browser-inspect` + `browser-scroll` CSP-strict smoke — generic
 * stealth-backend regression net.
 *
 * The sibling `inspect-eval-smoke.test.ts` runs the EXTRACTOR_SCRIPT
 * against MiniWoB++ task pages, which are benign HTML with **no
 * Content-Security-Policy**. That is why it missed this class of bug:
 * the failure only manifests on CSP-strict sites (e.g. Reddit, which
 * forbids `unsafe-eval`).
 *
 * Root cause this test guards against: some patched-Firefox stealth
 * binaries route `page.evaluate` through `eval()` in the page's *main*
 * world (a stealth measure that kills Juggler's isolated-world debugger
 * signature). The page's CSP then applies, so `page.evaluate` fails
 * with `"call to eval() blocked by CSP"`. Camoufox is NOT affected
 * (its binary keeps Juggler's CSP-free isolated-world +
 * `MainWorldContext.executeInGlobal` paths); other patched binaries
 * are.
 *
 * The fixes:
 *  - `_csp_safe_readonly_via_init_script = True` → `do_evaluate(read_only=True)`
 *    reads the EXTRACTOR_SCRIPT result from a `<meta>` tag populated by
 *    a CSP-free `context.add_init_script` (isolated world) at
 *    `DOMContentLoaded`, via native `query_selector` + `get_attribute`.
 *  - `_scroll_via_wheel = True` → `do_scroll` uses `page.mouse.wheel`
 *    instead of `page.evaluate("window.scrollBy")`.
 *
 * This file discovers every user-managed stealth backend under
 * `~/.pi/agent/pi-lean-portal/user-backends/` (or `PI_USER_BACKENDS_DIR`)
 * and runs both smokes against each — so any present backend (shipped
 * Camoufox template, a scratch validation backend, future engines) is
 * exercised. No backend is named here. Auto-skips per-backend when its
 * venv isn't installed, so `npm test` / `npm run test:ci` stay green in
 * bare CI; when the user-backends root is empty the file is a no-op.
 *
 * Run: npx vitest run bench/miniwob/suites/inspect-csp-smoke.test.ts
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

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

// ─── CSP-strict fixtures ──────────────────────────────────────────
//
// A Reddit-like page with a strict CSP that forbids `unsafe-eval`
// (exactly the policy that blocks `page.evaluate` on the affected
// patched binaries). Has enough content for every ExtractResult array
// to be non-empty so the smoke assertion is meaningful.

const CSP_STRICT_HTML = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data:;">
<title>r/LocalLLaMA CSP Smoke</title>
<style>body{display:block}h1{color:#333}</style>
</head>
<body>
  <h1>r/LocalLLaMA</h1>
  <h2>Hot Posts</h2>
  <p>First post about local models running on consumer GPUs.</p>
  <p>Second post about quantization techniques for large models.</p>
  <a href="/p1">Post one</a>
  <a href="/p2">Post two</a>
  <img alt="diagram of gpu memory layout" src="data:image/svg+xml,%3Csvg/%3E">
  <button>Upvote</button>
  <button>Comments</button>
  <input type="text" placeholder="Search the subreddit">
</body></html>`;

/** CSP-strict scroll fixture — same policy, tall enough to scroll. */
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

// ─── Shared HTTP server (file-level teardown) ─────────────────────

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

// ─── Shared test bodies ──────────────────────────────────────────

async function runCspScrollSmoke(plugin: BrowserPlugin, url: string) {
	const taskId = "csp-scroll-smoke";

	const nav = await plugin.navigate(url, taskId, 30_000);
	expect(
		nav.success,
		`navigate to CSP-strict scroll page failed: ${nav.error ?? "<no error>"}`,
	).toBe(true);

	// Scroll down — this must NOT use page.evaluate(window.scrollBy),
	// which would be blocked by CSP on patched-Firefox binaries that
	// route evaluate through eval() in the main world.  If this fails,
	// the backend is still using page.evaluate for scroll instead of
	// page.mouse.wheel (set _scroll_via_wheel = True).
	const scrollDown = await plugin.scroll(taskId, "down");
	expect(
		scrollDown.success,
		`scroll down on CSP-strict page failed: ${scrollDown.error ?? "<no error>"}`,
	).toBe(true);

	// Scroll back up
	const scrollUp = await plugin.scroll(taskId, "up");
	expect(
		scrollUp.success,
		`scroll up on CSP-strict page failed: ${scrollUp.error ?? "<no error>"}`,
	).toBe(true);
}

async function runCspSmoke(plugin: BrowserPlugin, url: string) {
	const taskId = "csp-smoke";

	// 1. Navigate — must succeed and populate the a11y tree. The page
	//    loads fine; only the subsequent eval is CSP-blocked on
	//    affected binaries.
	const nav = await plugin.navigate(url, taskId, 30_000);
	expect(nav.success, `navigate failed: ${nav.error ?? "<no error>"}`).toBe(
		true,
	);
	expect(nav.elementCount).toBeGreaterThan(0);

	// 2. Evaluate the real EXTRACTOR_SCRIPT as a read-only eval. Must
	//    succeed (no "call to eval() blocked by CSP") and return a
	//    parseable ExtractResult — either via the CSP-safe init-script
	//    handoff (affected binaries) or via plain page.evaluate
	//    (CSP-free binaries like Camoufox).
	const evalResult = await plugin.evaluate(taskId, EXTRACTOR_SCRIPT, true);
	expect(
		evalResult.success,
		`evaluate EXTRACTOR_SCRIPT failed on CSP-strict page: ${evalResult.error ?? "<no error>"}`,
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

	expect(parsed.title, "ExtractResult.title missing").toBe(
		"r/LocalLLaMA CSP Smoke",
	);
	// Every content array should be populated — the fixture has at least
	// one of each. A CSP-blocked eval returns success=false (asserted
	// above); a silently-empty extraction would pass the success gate but
	// fail here, catching a broken init-script handoff (e.g. a wrapper
	// SyntaxError that no-ops at document-start).
	expect(parsed.headings.length, "headings empty").toBeGreaterThan(0);
	expect(parsed.paragraphs.length, "paragraphs empty").toBeGreaterThan(0);
	expect(parsed.links.length, "links empty").toBeGreaterThan(0);
	expect(parsed.images.length, "images empty").toBeGreaterThan(0);
	expect(parsed.interactive.length, "interactive empty").toBeGreaterThan(0);
}

// ─── Stealth-backend discovery ────────────────────────────────────
//
// `discoverUserBackends` (imported from the shared probe helper) scans
// the user-backends root for `<name>-py/` dirs containing a `bridge.py`.
// No stealth engine is named — whatever the user has installed is what
// runs. Empty root (the normal bare-CI state) → register nothing, the
// file is a no-op.

const discovered = discoverUserBackends(userBackendsDir());

for (const name of discovered) {
	const PROBE = probeUserBackend(name);
	const SHOULD_RUN = PROBE.available;

	describe(`inspect-csp-smoke — ${name}`, () => {
		let plugin: BrowserPlugin | undefined;

		beforeAll(async () => {
			if (!SHOULD_RUN) return;
			plugin = new PythonPluginAdapter(name, {
				bridgeScript: PROBE.bridgePath,
				pythonPath: PROBE.venvPython,
				// `engine` omitted — the smoke does navigate/scroll/evaluate,
				// none of which consult capabilities.engine. A backend whose
				// binary is Firefox-based doesn't need it asserted here.
				capabilities: {
					supportsFullPageScreenshot: true,
					supportsConsoleCapture: true,
					supportsJavaScriptEvaluate: true,
					supportsBotDetection: true,
					supportsDialogAutoDismissal: true,
					supportsAbortSignal: false,
				},
			});
			await plugin.init?.({});
		});

		afterAll(async () => {
			if (plugin) await plugin.cleanupAll().catch(() => {});
		});

		const itFn = SHOULD_RUN ? it : it.skip;
		itFn(
			SHOULD_RUN
				? "EXTRACTOR_SCRIPT succeeds on a CSP-strict page"
				: `prerequisites missing: ${name} user-backend not installed (${PROBE.reason ?? ""})`,
			async () => {
				await runCspSmoke(plugin!, baseUrl);
			},
			120_000,
		);

		itFn(
			SHOULD_RUN
				? "scrolls on a CSP-strict page"
				: `prerequisites missing: ${name} user-backend not installed (${PROBE.reason ?? ""})`,
			async () => {
				await runCspScrollSmoke(plugin!, cspScrollUrl);
			},
			120_000,
		);
	});
}
