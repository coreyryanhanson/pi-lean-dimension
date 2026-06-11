/**
 * Plugin Contract Test Harness — reusable test suite that validates
 * any BrowserPlugin implementation against the expected API contract.
 *
 * Usage:
 *   import { runContractTests } from "./helpers/plugin-contract.js";
 *   import { MockPlugin } from "./helpers/mock-plugin.js";
 *
 *   runContractTests("mock", () => new MockPlugin());
 *
 * For real-browser plugins (ChromiumPlugin, PythonPluginAdapter):
 *   runContractTests("chromium", () => new ChromiumPlugin(), {
 *     realBrowser: true,
 *   });
 */

import {
	describe,
	it,
	expect,
	beforeAll,
	afterAll,
	beforeEach,
	afterEach,
} from "vitest";
import type { BrowserPlugin, PluginCapabilities } from "../../core/plugin-api";
import { startTestServer, type TestServer } from "./test-server.js";
import {
	REDDIT_DIALOG_HTML,
	REDDIT_STACKED_HTML,
	REDDIT_ASYNC_HTML,
	REDDIT_FEED_ONLY_HTML,
	findRef,
	dialogCount,
} from "./reddit-fixture.js";

// ─── Options ──────────────────────────────────────────────────────

export interface ContractTestOptions {
	/**
	 * Set true when the plugin drives a real browser (ChromiumPlugin,
	 * PythonPluginAdapter).  Enables behavioral tests that navigate to
	 * an HTTP test server and interact with real DOM elements.
	 *
	 * When false (default), only structural/shape tests run — these
	 * work with MockPlugin and validate result types without a browser.
	 */
	realBrowser?: boolean;

	/**
	 * Maximum time to wait for navigation (ms).  Default: 15_000.
	 * Only used when realBrowser is true.
	 */
	navigateTimeout?: number;
}

// ─── HTML Fixtures ────────────────────────────────────────────────

/** Simple page with a title and some text. */
const SIMPLE_HTML = `<!DOCTYPE html>
<html><head><title>Contract Test — Simple</title></head>
<body>
  <h1>Simple Page</h1>
  <p>Hello from the contract test server.</p>
</body></html>`;

/** Page with a link and a button that can be clicked. */
const INTERACTIVE_HTML = `<!DOCTYPE html>
<html><head><title>Contract Test — Interactive</title></head>
<body>
  <h1>Interactive Page</h1>
  <nav><a href="/simple">Go to simple page</a></nav>
  <main>
    <button id="counter-btn" type="button">Click me</button>
    <p id="counter">0</p>
    <input id="text-input" type="text" placeholder="Type here" />
    <label for="text-input">Name</label>
    <textarea id="area" rows="3"></textarea>
  </main>
  <script>
    let count = 0;
    document.getElementById('counter-btn').addEventListener('click', () => {
      count++;
      document.getElementById('counter').textContent = count;
    });
    console.log('page loaded');
  </script>
</body></html>`;

/** Page with images. */
const IMAGES_HTML = `<!DOCTYPE html>
<html><head><title>Contract Test — Images</title></head>
<body>
  <h1>Image Page</h1>
  <img src="/img/logo.png" alt="Logo" width="200" height="50" />
  <img src="/img/photo.jpg" alt="Photo" width="640" height="480" />
</body></html>`;

/** Long page that requires scrolling. */
const SCROLL_HTML = `<!DOCTYPE html>
<html><head><title>Contract Test — Scroll</title></head>
<body>
  <h1>Scroll Test</h1>
  ${Array.from({ length: 50 }, (_, i) => `<p>Paragraph ${i + 1}: This is content to make the page scrollable.</p>`).join("\n  ")}
  <p id="bottom-marker">You reached the bottom!</p>
</body></html>`;

/** Page that uses console.log, console.warn, console.error. */
const CONSOLE_HTML = `<!DOCTYPE html>
<html><head><title>Contract Test — Console</title></head>
<body>
  <h1>Console Test</h1>
  <script>
    console.log("hello from console");
    console.warn("a warning");
    console.error("an error");
  </script>
</body></html>`;

/** Two-page navigation sequence for goBack testing. */
const PAGE_A_HTML = `<!DOCTYPE html>
<html><head><title>Page A</title></head>
<body>
  <h1>Page A</h1>
  <a href="/page-b">Go to Page B</a>
</body></html>`;

const PAGE_B_HTML = `<!DOCTYPE html>
<html><head><title>Page B</title></head>
<body>
  <h1>Page B</h1>
  <p>You are on page B.</p>
</body></html>`;

/** Page with duplicate accessible elements — tests strict-mode disambiguation.
 *
 * Three links all expose the same name "Same Link" in the accessibility tree.
 * Each navigates to a different destination so we can verify the correct one
 * was clicked.  The input fields also share the same name for type testing.
 */
const DUPLICATE_HTML = `<!DOCTYPE html>
<html><head><title>Contract Test — Duplicates</title></head>
<body>
  <h1>Duplicate Elements</h1>
  <nav>
    <a href="/page-a" id="link-1">Same Link</a>
    <a href="/page-b" id="link-2">Same Link</a>
    <a href="/page-a" id="link-3">Same Link</a>
  </nav>
  <p id="output">ready</p>
</body></html>`;

/** Page with a modal overlay — tests occlusion detection.
 *
 * A fixed-position overlay covers a background button.  The overlay itself
 * contains interactive elements (accept / close buttons).  Clicking the
 * background button should trigger the occlusion check and fail with a
 * clear error, while clicking the overlay's own buttons should succeed.
 */
const MODAL_HTML = `<!DOCTYPE html>
<html><head><title>Contract Test — Modal Overlay</title></head>
<body>
  <div id="overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
    <div id="modal" style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
      <p>Cookie Preferences</p>
      <button id="accept-btn" type="button">Accept all cookies</button>
      <button id="close-btn" type="button" onclick="document.getElementById('overlay').style.display='none'">Close</button>
    </div>
  </div>
  <h1>Underlying Content</h1>
  <button id="hidden-btn" type="button">This button is obscured</button>
  <p>Some content behind the modal.</p>
</body></html>`;

/** 404 page. */
const NOT_FOUND_HTML = `<!DOCTYPE html>
<html><head><title>Not Found</title></head>
<body><h1>404 — Page Not Found</h1></body></html>`;

/** 1x1 transparent PNG, pre-decoded for image serving. */
const PIXEL_PNG_BUFFER = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

// ─── Test Server Router ──────────────────────────────────────────

/**
 * Build an HTTP request handler that serves the contract test fixtures.
 * Image paths return a tiny PNG; HTML paths return the fixture.
 */
function contractTestHandler(
	req: import("node:http").IncomingMessage,
	res: import("node:http").ServerResponse,
): void {
	const url = new URL(req.url ?? "/", "http://localhost");

	// Image endpoint
	if (url.pathname.startsWith("/img/")) {
		res.writeHead(200, {
			"Content-Type": "image/png",
			"Content-Length": PIXEL_PNG_BUFFER.length,
		});
		res.end(PIXEL_PNG_BUFFER);
		return;
	}

	// HTML pages
	const pages: Record<string, string> = {
		"/simple": SIMPLE_HTML,
		"/interactive": INTERACTIVE_HTML,
		"/images": IMAGES_HTML,
		"/scroll": SCROLL_HTML,
		"/console": CONSOLE_HTML,
		"/page-a": PAGE_A_HTML,
		"/page-b": PAGE_B_HTML,
		"/duplicates": DUPLICATE_HTML,
		"/modal": MODAL_HTML,
		"/reddit-dialog": REDDIT_DIALOG_HTML,
		"/reddit-stacked": REDDIT_STACKED_HTML,
		"/reddit-async": REDDIT_ASYNC_HTML,
		"/reddit-feed": REDDIT_FEED_ONLY_HTML,
	};

	const html = pages[url.pathname];
	if (html) {
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
		});
		res.end(html);
		return;
	}

	// Root redirects to /simple
	if (url.pathname === "/") {
		res.writeHead(302, { Location: "/simple" });
		res.end();
		return;
	}

	// Everything else is 404
	res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
	res.end(NOT_FOUND_HTML);
}

// ─── Main Export ─────────────────────────────────────────────────

/**
 * Register a full contract test suite for a BrowserPlugin.
 *
 * @param name        Display name for the test suite (e.g. "mock", "chromium")
 * @param createPlugin  Factory that creates a fresh plugin instance
 * @param options     Configuration for which test groups to run
 */
export function runContractTests(
	name: string,
	createPlugin: () => BrowserPlugin | Promise<BrowserPlugin>,
	options: ContractTestOptions = {},
): void {
	const { realBrowser = false, navigateTimeout = 15_000 } = options;
	const TASK_ID = "contract-test";

	// ═══════════════════════════════════════════════════════════
	// Structural tests — work with any BrowserPlugin (including MockPlugin)
	// ═══════════════════════════════════════════════════════════

	describe(`BrowserPlugin contract — ${name}`, () => {
		let plugin: BrowserPlugin;

		beforeEach(async () => {
			plugin = await createPlugin();
		});

		afterEach(async () => {
			await plugin.cleanupAll().catch(() => {});
		});

		// ─── Identity & Capabilities ───────────────────────────

		describe("identity", () => {
			it("has a non-empty name", () => {
				expect(plugin.name).toBeTruthy();
				expect(typeof plugin.name).toBe("string");
			});

			it("has complete capabilities", () => {
				const caps: PluginCapabilities = plugin.capabilities;
				expect(typeof caps.supportsFullPageScreenshot).toBe("boolean");
				expect(typeof caps.supportsConsoleCapture).toBe("boolean");
				expect(typeof caps.supportsJavaScriptEvaluate).toBe("boolean");
				expect(typeof caps.supportsBotDetection).toBe("boolean");
				expect(typeof caps.supportsDialogAutoDismissal).toBe("boolean");
				expect(typeof caps.supportsAbortSignal).toBe("boolean");
				expect(typeof caps.engine).toBe("string");
			});
		});

		// ─── Navigate ─────────────────────────────────────────

		describe("navigate()", () => {
			it("returns a NavigateResult with required fields", async () => {
				const result = await plugin.navigate(
					"https://example.com/",
					TASK_ID,
					30_000,
				);

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");
				expect(typeof result.url).toBe("string");
				expect(typeof result.title).toBe("string");
				expect(typeof result.snapshot).toBe("string");
				expect(typeof result.elementCount).toBe("number");

				if (result.success) {
					expect(result.url).toBeTruthy();
					expect(result.snapshot).toBeTruthy();
					expect(result.elementCount).toBeGreaterThanOrEqual(0);
				} else {
					expect(result.error).toBeTruthy();
				}
			});

			it("returns a well-formed result for any URL (success or error)", async () => {
				const result = await plugin.navigate("not-a-url", TASK_ID, 30_000);

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");
				if (!result.success) {
					expect(result.error).toBeTruthy();
				}
			});

			it("does not set botDetected for normal pages", async () => {
				const result = await plugin.navigate(
					"https://example.com/",
					TASK_ID,
					30_000,
				);

				if (result.success) {
					expect(result.botDetected).toBeFalsy();
				}
			});
		});

		// ─── Snapshot ─────────────────────────────────────────

		describe("snapshot()", () => {
			it("returns a SnapshotResult with required fields", async () => {
				// Ensure a session exists first
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.snapshot(TASK_ID);

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");
				expect(typeof result.snapshot).toBe("string");
				expect(typeof result.elementCount).toBe("number");

				if (result.success) {
					expect(result.snapshot).toBeTruthy();
					expect(result.elementCount).toBeGreaterThanOrEqual(0);
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── Click ────────────────────────────────────────────

		describe("click()", () => {
			it("returns an InteractionResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				// Use a ref that might exist; structural test just checks shape
				const result = await plugin.click(TASK_ID, "@e1");

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					// snapshot and elementCount are optional on success
					if (result.snapshot !== undefined) {
						expect(typeof result.snapshot).toBe("string");
					}
					if (result.elementCount !== undefined) {
						expect(typeof result.elementCount).toBe("number");
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── Type ────────────────────────────────────────────

		describe("type()", () => {
			it("returns an InteractionResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.type(TASK_ID, "@e1", "hello");

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					if (result.snapshot !== undefined) {
						expect(typeof result.snapshot).toBe("string");
					}
					if (result.elementCount !== undefined) {
						expect(typeof result.elementCount).toBe("number");
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── Scroll ──────────────────────────────────────────

		describe("scroll()", () => {
			it("returns an InteractionResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.scroll(TASK_ID, "down");

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					if (result.snapshot !== undefined) {
						expect(typeof result.snapshot).toBe("string");
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});

			it("accepts 'up' direction", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.scroll(TASK_ID, "up");

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");
			});
		});

		// ─── GoBack ──────────────────────────────────────────

		describe("goBack()", () => {
			it("returns an InteractionResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.goBack(TASK_ID);

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					// newUrl and newTitle are optional
					if (result.newUrl !== undefined) {
						expect(typeof result.newUrl).toBe("string");
					}
					if (result.newTitle !== undefined) {
						expect(typeof result.newTitle).toBe("string");
					}
					if (result.snapshot !== undefined) {
						expect(typeof result.snapshot).toBe("string");
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── Press ───────────────────────────────────────────

		describe("press()", () => {
			it("returns an InteractionResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.press(TASK_ID, "Enter");

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					if (result.snapshot !== undefined) {
						expect(typeof result.snapshot).toBe("string");
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── Screenshot ──────────────────────────────────────

		describe("screenshot()", () => {
			it("returns a ScreenshotResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.screenshot(TASK_ID);

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					expect(result.dataUri).toBeTruthy();
					expect(typeof result.dataUri).toBe("string");
					// Should be a JPEG data URI
					expect(result.dataUri).toMatch(/^data:image\/jpeg;base64,/);
				} else {
					expect(result.error).toBeTruthy();
				}
			});

			it("accepts fullPage option when supported", async () => {
				if (!plugin.capabilities.supportsFullPageScreenshot) return;

				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.screenshot(TASK_ID, {
					fullPage: true,
				});

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");
			});
		});

		// ─── GetImages ───────────────────────────────────────

		describe("getImages()", () => {
			it("returns a GetImagesResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.getImages(TASK_ID);

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					expect(Array.isArray(result.images)).toBe(true);
					for (const img of result.images) {
						expect(typeof img.src).toBe("string");
						expect(typeof img.alt).toBe("string");
						expect(typeof img.width).toBe("number");
						expect(typeof img.height).toBe("number");
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── Console ─────────────────────────────────────────

		describe("getConsoleMessages()", () => {
			it("returns a ConsoleMessagesResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				const result = await plugin.getConsoleMessages(TASK_ID);

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					expect(Array.isArray(result.messages)).toBe(true);
					for (const msg of result.messages) {
						expect(typeof msg.type).toBe("string");
						expect(typeof msg.text).toBe("string");
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── ClearConsole ────────────────────────────────────

		describe("clearConsole()", () => {
			it("does not throw", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				// Should resolve without error
				await expect(plugin.clearConsole(TASK_ID)).resolves.toBeUndefined();
			});
		});

		// ─── Evaluate ────────────────────────────────────────

		describe("evaluate()", () => {
			it("returns an EvaluateResult with required fields", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				if (!plugin.capabilities.supportsJavaScriptEvaluate) {
					return;
				}

				const result = await plugin.evaluate(TASK_ID, "1 + 1");

				expect(result).toBeDefined();
				expect(typeof result.success).toBe("boolean");

				if (result.success) {
					// result.result is optional (unknown type) — structural
					// test validates type only, not value
					if (result.result !== undefined) {
						expect(result.result).toBeDefined();
					}
				} else {
					expect(result.error).toBeTruthy();
				}
			});
		});

		// ─── Cleanup ────────────────────────────────────────

		describe("cleanup()", () => {
			it("does not throw for an active session", async () => {
				await plugin.navigate("https://example.com/", TASK_ID, 30_000);

				await expect(plugin.cleanup(TASK_ID)).resolves.toBeUndefined();
			});
		});

		// ─── CleanupAll ──────────────────────────────────────

		describe("cleanupAll()", () => {
			it("does not throw", async () => {
				await expect(plugin.cleanupAll()).resolves.toBeUndefined();
			});
		});
	});

	// ═══════════════════════════════════════════════════════════
	// Behavioral tests — require realBrowser and an HTTP test server
	// ═══════════════════════════════════════════════════════════

	if (!realBrowser) return;

	describe(`BrowserPlugin behavioral contract — ${name}`, () => {
		let plugin: BrowserPlugin;
		let server: TestServer;

		beforeAll(async () => {
			server = await startTestServer(contractTestHandler);
		});

		afterAll(async () => {
			await server.stop();
		});

		beforeEach(async () => {
			plugin = await createPlugin();
		});

		afterEach(async () => {
			await plugin.cleanupAll().catch(() => {});
		});

		// ─── Navigate ─────────────────────────────────────────

		describe("navigate() — real pages", () => {
			it("loads a page and returns correct title", async () => {
				const result = await plugin.navigate(
					`${server.url}/simple`,
					TASK_ID,
					navigateTimeout,
				);

				expect(result.success).toBe(true);
				expect(result.title).toBe("Contract Test — Simple");
				expect(result.url).toContain("/simple");
			});

			it("returns a snapshot with @e refs for interactive elements", async () => {
				const result = await plugin.navigate(
					`${server.url}/interactive`,
					TASK_ID,
					navigateTimeout,
				);

				expect(result.success).toBe(true);
				expect(result.snapshot).toBeTruthy();
				// Interactive page should have at least some elements
				expect(result.elementCount).toBeGreaterThan(0);
			});

			it("follows redirects", async () => {
				const result = await plugin.navigate(
					server.url,
					TASK_ID,
					navigateTimeout,
				);

				expect(result.success).toBe(true);
				expect(result.url).toContain("/simple");
			});

			it("handles 404 pages", async () => {
				const result = await plugin.navigate(
					`${server.url}/nonexistent`,
					TASK_ID,
					navigateTimeout,
				);

				// 404 is still a successful page load
				expect(result.success).toBe(true);
				expect(result.title).toBe("Not Found");
			});
		});

		// ─── Click ────────────────────────────────────────────

		describe("click() — real interaction", () => {
			it("clicks a link and navigates", async () => {
				await plugin.navigate(
					`${server.url}/interactive`,
					TASK_ID,
					navigateTimeout,
				);

				// Find the link @e ref from the snapshot
				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Extract a link ref from the snapshot
				const linkMatch = snap.snapshot.match(/@e(\d+)/);
				expect(linkMatch).toBeTruthy();

				const ref = `@e${linkMatch![1]}`;
				const result = await plugin.click(TASK_ID, ref);

				expect(result.success).toBe(true);
				// After clicking a link, the page may have changed
				if (result.snapshot) {
					expect(typeof result.snapshot).toBe("string");
				}
			});

			it("clicks duplicate-named links without strict-mode violation", async () => {
				await plugin.navigate(
					`${server.url}/duplicates`,
					TASK_ID,
					navigateTimeout,
				);

				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Extract all link @e refs from the snapshot
				const linkRefs: string[] = [];
				const linkMatches = snap.snapshot.matchAll(/@(e\d+)\s.*?link/g);
				for (const m of linkMatches) {
					linkRefs.push(`@${m[1]!}`);
				}

				expect(linkRefs.length).toBeGreaterThanOrEqual(3);

				// Click each duplicate link in sequence — should not throw strict mode
				// Each link with the same name "Same Link" must be clickable via its @e ref
				for (const ref of linkRefs) {
					const result = await plugin.click(TASK_ID, ref);
					expect(result.success).toBe(true);

					// Navigate back to duplicates page for next click
					await plugin.navigate(
						`${server.url}/duplicates`,
						TASK_ID,
						navigateTimeout,
					);
				}
			});

			it("rejects clicks on elements obscured by a modal overlay", async () => {
				await plugin.navigate(`${server.url}/modal`, TASK_ID, navigateTimeout);

				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Find the obscured button's @e ref in the snapshot text
				const lines = snap.snapshot.split("\n");
				const btnLine = lines.find((l: string) =>
					l.includes("This button is obscured"),
				);
				expect(btnLine).toBeTruthy();
				const refMatch = btnLine!.match(/@(e\d+)/);
				expect(refMatch).toBeTruthy();
				const ref = `@${refMatch![1]}`;

				const result = await plugin.click(TASK_ID, ref);

				expect(result.success).toBe(false);
				expect(result.error).toMatch(/obscured/i);
			});

			it("click on overlay elements succeeds (not blocked by occlusion check)", async () => {
				await plugin.navigate(`${server.url}/modal`, TASK_ID, navigateTimeout);

				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Find the "Accept all cookies" button in the overlay — this should
				// NOT be occluded because it IS the foreground element.
				const lines = snap.snapshot.split("\n");
				const acceptLine = lines.find((l: string) =>
					l.includes("Accept all cookies"),
				);
				expect(acceptLine).toBeTruthy();
				const refMatch = acceptLine!.match(/@(e\d+)/);
				expect(refMatch).toBeTruthy();
				const ref = `@${refMatch![1]}`;

				const result = await plugin.click(TASK_ID, ref);
				// The overlay button should be clickable
				expect(result.success).toBe(true);
			});
		});

		// ─── Type ────────────────────────────────────────────

		describe("type() — real interaction", () => {
			it("types into an input field", async () => {
				await plugin.navigate(
					`${server.url}/interactive`,
					TASK_ID,
					navigateTimeout,
				);

				// Find an input ref
				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Look for textbox in the snapshot (input fields are role=textbox)
				const inputMatch = snap.snapshot.match(/textbox[^\n]*@e(\d+)/);
				if (!inputMatch) {
					return;
				}

				const ref = `@e${inputMatch[1]}`;
				const result = await plugin.type(TASK_ID, ref, "hello world");

				expect(result.success).toBe(true);
			});
		});

		// ─── Scroll ──────────────────────────────────────────

		describe("scroll() — real interaction", () => {
			it("scrolls down on a long page", async () => {
				await plugin.navigate(`${server.url}/scroll`, TASK_ID, navigateTimeout);

				const result = await plugin.scroll(TASK_ID, "down");

				expect(result.success).toBe(true);
			});

			it("scrolls back up", async () => {
				await plugin.navigate(`${server.url}/scroll`, TASK_ID, navigateTimeout);

				await plugin.scroll(TASK_ID, "down");
				const result = await plugin.scroll(TASK_ID, "up");

				expect(result.success).toBe(true);
			});
		});

		// ─── GoBack ──────────────────────────────────────────

		describe("goBack() — real navigation", () => {
			it("navigates back to the previous page", async () => {
				// Navigate to page A, then click link to page B
				await plugin.navigate(`${server.url}/page-a`, TASK_ID, navigateTimeout);

				// Navigate to page B
				await plugin.navigate(`${server.url}/page-b`, TASK_ID, navigateTimeout);

				// Go back
				const result = await plugin.goBack(TASK_ID);

				expect(result.success).toBe(true);
				if (result.newUrl) {
					expect(result.newUrl).toContain("/page-a");
				}
			});
		});

		// ─── Press ───────────────────────────────────────────

		describe("press() — real interaction", () => {
			it("presses Enter key", async () => {
				await plugin.navigate(
					`${server.url}/interactive`,
					TASK_ID,
					navigateTimeout,
				);

				const result = await plugin.press(TASK_ID, "Enter");

				expect(result.success).toBe(true);
			});
		});

		// ─── Screenshot ──────────────────────────────────────

		describe("screenshot() — real capture", () => {
			it("returns a valid JPEG data URI", async () => {
				await plugin.navigate(`${server.url}/simple`, TASK_ID, navigateTimeout);

				const result = await plugin.screenshot(TASK_ID);

				expect(result.success).toBe(true);
				expect(result.dataUri).toMatch(
					/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/,
				);
				// Should have reasonable base64 length (at least a few KB)
				const base64 = result.dataUri.split(",")[1]!;
				expect(base64.length).toBeGreaterThan(100);
			});
		});

		// ─── GetImages ───────────────────────────────────────

		describe("getImages() — real extraction", () => {
			it("extracts images from the page", async () => {
				await plugin.navigate(`${server.url}/images`, TASK_ID, navigateTimeout);

				const result = await plugin.getImages(TASK_ID);

				expect(result.success).toBe(true);
				expect(result.images.length).toBeGreaterThanOrEqual(2);

				const srcs = result.images.map((img) => img.src);
				expect(srcs.some((s) => s.includes("logo.png"))).toBe(true);
				expect(srcs.some((s) => s.includes("photo.jpg"))).toBe(true);
			});
		});

		// ─── Console ─────────────────────────────────────────

		describe("console — real capture", () => {
			it("captures console messages from the page", async () => {
				if (!plugin.capabilities.supportsConsoleCapture) return;

				await plugin.navigate(
					`${server.url}/console`,
					TASK_ID,
					navigateTimeout,
				);

				const result = await plugin.getConsoleMessages(TASK_ID);

				expect(result.success).toBe(true);
				expect(result.messages.length).toBeGreaterThan(0);

				const texts = result.messages.map((m) => m.text);
				expect(texts.some((t) => t.includes("hello from console"))).toBe(true);
			});

			it("clears console messages", async () => {
				if (!plugin.capabilities.supportsConsoleCapture) return;

				await plugin.navigate(
					`${server.url}/console`,
					TASK_ID,
					navigateTimeout,
				);

				await plugin.clearConsole(TASK_ID);

				const result = await plugin.getConsoleMessages(TASK_ID);
				expect(result.success).toBe(true);
				expect(result.messages).toHaveLength(0);
			});
		});

		// ─── Evaluate ────────────────────────────────────────

		describe("evaluate() — real execution", () => {
			it("evaluates a JavaScript expression", async () => {
				if (!plugin.capabilities.supportsJavaScriptEvaluate) return;

				await plugin.navigate(`${server.url}/simple`, TASK_ID, navigateTimeout);

				const result = await plugin.evaluate(TASK_ID, "document.title");

				expect(result.success).toBe(true);
				expect(result.result).toBe("Contract Test — Simple");
			});

			it("evaluates arithmetic", async () => {
				if (!plugin.capabilities.supportsJavaScriptEvaluate) return;

				await plugin.navigate(`${server.url}/simple`, TASK_ID, navigateTimeout);

				const result = await plugin.evaluate(TASK_ID, "2 + 3");

				expect(result.success).toBe(true);
				expect(result.result).toBe(5);
			});

			it("returns error for invalid expressions", async () => {
				if (!plugin.capabilities.supportsJavaScriptEvaluate) return;

				await plugin.navigate(`${server.url}/simple`, TASK_ID, navigateTimeout);

				const result = await plugin.evaluate(
					TASK_ID,
					"throw new Error('test error')",
				);

				expect(result.success).toBe(false);
				expect(result.error).toBeTruthy();
			});
		});

		// ─── Lifecycle ───────────────────────────────────────

		describe("lifecycle — real sessions", () => {
			it("creates and cleans up a session", async () => {
				await plugin.navigate(`${server.url}/simple`, TASK_ID, navigateTimeout);

				// Session should be working
				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Cleanup
				await plugin.cleanup(TASK_ID);

				// After cleanup, snapshot should fail
				const afterCleanup = await plugin.snapshot(TASK_ID);
				expect(afterCleanup.success).toBe(false);
			});

			it("isolates sessions by taskId", async () => {
				const TASK_A = "task-a";
				const TASK_B = "task-b";

				await plugin.navigate(`${server.url}/simple`, TASK_A, navigateTimeout);

				await plugin.navigate(
					`${server.url}/interactive`,
					TASK_B,
					navigateTimeout,
				);

				// Each session should have its own snapshot
				const snapA = await plugin.snapshot(TASK_A);
				const snapB = await plugin.snapshot(TASK_B);

				expect(snapA.success).toBe(true);
				expect(snapB.success).toBe(true);

				// Different pages → different content
				expect(snapA.snapshot).not.toBe(snapB.snapshot);

				// Cleanup
				await plugin.cleanup(TASK_A);
				await plugin.cleanup(TASK_B);
			});
		});

		// ─── Reddit dialog fixtures ─────────────────────────

		describe("reddit dialog fixtures", () => {
			it("dialog appears in snapshot after navigate", async () => {
				const result = await plugin.navigate(
					`${server.url}/reddit-dialog`,
					TASK_ID,
					navigateTimeout,
				);

				expect(result.success).toBe(true);
				expect(result.elementCount).toBeGreaterThan(0);
				expect(result.snapshot).toContain("Consent");

				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);
				expect(dialogCount(snap.snapshot)).toBeGreaterThanOrEqual(1);
			});

			it("'Reject All' (nested SVG) is clickable", async () => {
				await plugin.navigate(
					`${server.url}/reddit-dialog`,
					TASK_ID,
					navigateTimeout,
				);

				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				const info = findRef(snap.snapshot, "Reject All");
				if (!info) {
					// If the element is beyond the cap, skip
					return;
				}

				const result = await plugin.click(TASK_ID, info.ref);
				expect(result.success).toBe(true);

				const after = await plugin.snapshot(TASK_ID);
				expect(after.success).toBe(true);
				expect(dialogCount(after.snapshot)).toBe(0);
			});

			it("'Accept All' (plain button) is clickable", async () => {
				await plugin.navigate(
					`${server.url}/reddit-dialog`,
					TASK_ID,
					navigateTimeout,
				);

				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				const info = findRef(snap.snapshot, "Accept All");
				if (!info) {
					return;
				}

				const result = await plugin.click(TASK_ID, info.ref);
				expect(result.success).toBe(true);

				const after = await plugin.snapshot(TASK_ID);
				expect(after.success).toBe(true);
				expect(dialogCount(after.snapshot)).toBe(0);
			});

			it("stacked dialogs close in sequence", async () => {
				const STACKED_TASK = "stacked-test";

				await plugin.navigate(
					`${server.url}/reddit-stacked`,
					STACKED_TASK,
					navigateTimeout,
				);

				// First snapshot — consent dialog should be visible
				const snap1 = await plugin.snapshot(STACKED_TASK);
				expect(snap1.success).toBe(true);
				expect(dialogCount(snap1.snapshot)).toBeGreaterThanOrEqual(1);

				// Click "Reject All" to dismiss consent dialog
				const info1 = findRef(snap1.snapshot, "Reject All");
				if (!info1) {
					await plugin.cleanup(STACKED_TASK);
					return;
				}
				const result1 = await plugin.click(STACKED_TASK, info1.ref);
				expect(result1.success).toBe(true);

				// Second snapshot — "Welcome Back" dialog should now be visible
				const snap2 = await plugin.snapshot(STACKED_TASK);
				expect(snap2.success).toBe(true);
				expect(snap2.snapshot).toContain("Welcome");

				// Click "Dismiss" to close the welcome dialog
				const info2 = findRef(snap2.snapshot, "Dismiss");
				if (!info2) {
					await plugin.cleanup(STACKED_TASK);
					return;
				}
				const result2 = await plugin.click(STACKED_TASK, info2.ref);
				expect(result2.success).toBe(true);

				// Third snapshot — no dialogs should remain
				const snap3 = await plugin.snapshot(STACKED_TASK);
				expect(snap3.success).toBe(true);
				expect(dialogCount(snap3.snapshot)).toBe(0);

				await plugin.cleanup(STACKED_TASK);
			});

			it("async dialog eventually appears", async () => {
				const ASYNC_TASK = "async-test";

				await plugin.navigate(
					`${server.url}/reddit-async`,
					ASYNC_TASK,
					navigateTimeout,
				);

				// Wait for the async dialog to appear (setTimeout 500ms)
				await new Promise((r) => setTimeout(r, 1000));

				const snap = await plugin.snapshot(ASYNC_TASK);
				expect(snap.success).toBe(true);
				expect(snap.snapshot).toContain("Consent");

				const info = findRef(snap.snapshot, "Reject All");
				if (!info) {
					await plugin.cleanup(ASYNC_TASK);
					return;
				}

				const result = await plugin.click(ASYNC_TASK, info.ref);
				expect(result.success).toBe(true);

				await plugin.cleanup(ASYNC_TASK);
			});

			it("feed link click blocked by dialog occlusion", async () => {
				await plugin.navigate(
					`${server.url}/reddit-dialog`,
					TASK_ID,
					navigateTimeout,
				);

				const snap = await plugin.snapshot(TASK_ID);
				expect(snap.success).toBe(true);

				// Find a feed post link — should be behind the dialog overlay
				const info = findRef(snap.snapshot, "Post Title");
				if (!info) {
					// 100 posts + dialog may push feed beyond element cap; skip
					return;
				}

				const result = await plugin.click(TASK_ID, info.ref);

				// The click should be blocked by the consent dialog overlay
				expect(result.success).toBe(false);
				expect(result.error).toBeTruthy();
			});
		});
	});
}
