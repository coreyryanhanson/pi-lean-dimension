/**
 * Tests for the Firefox launchServer reconnect path in PlaywrightPluginBase.
 *
 * Verifies:
 *   - `_wsEndpoint` / `_browserServer` lifecycle (survive disconnect)
 *   - `_reconnectBrowser()` is called on `disconnected`
 *   - `getAttachEndpoint()` returns `{kind:"firefox-ws", wsEndpoint}`
 *   - Session state (`_pages`, `_elementCache`, `_cdpEndpoint`) cleaned up
 *   - Handler nesting is bounded (one handler per Browser instance)
 *
 * All tests use EventEmitter-based mock Browser/BrowserServer objects —
 * no real browser or Python process involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PlaywrightPluginBase } from "../backends/playwright-base/playwright-plugin.js";
import { sessionManager } from "../core/shared/session-manager.js";
import {
	DEFAULT_CAPABILITIES,
	type PluginCapabilities,
	type AttachEndpoint,
} from "../core/plugin-api.js";

// ─── Mock Playwright types (EventEmitter-based) ──────────────────

/**
 * Create a mock Playwright BrowserContext.
 * All methods are vi.fn() stubs that return sensible defaults.
 */
function createMockContext(): EventEmitter {
	const ctx = new EventEmitter();
	(ctx as any).newPage = vi.fn<() => EventEmitter>(() => createMockPage());
	(ctx as any).close = vi.fn();
	(ctx as any).storageState = vi.fn().mockResolvedValue({
		cookies: [],
		origins: [],
	});
	(ctx as any).cookies = vi.fn().mockResolvedValue([]);
	(ctx as any).addCookies = vi.fn();
	(ctx as any).clearCookies = vi.fn();
	(ctx as any).tracing = {
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
	};
	return ctx;
}

/**
 * Create a mock Playwright Page.
 * All methods are vi.fn() stubs that return sensible defaults.
 */
function createMockPage(): EventEmitter {
	const page = new EventEmitter();
	(page as any).goto = vi.fn().mockResolvedValue(null);
	(page as any).waitForFunction = vi.fn().mockResolvedValue(undefined);
	(page as any).title = vi.fn().mockResolvedValue("Mock Title");
	(page as any).url = vi.fn().mockReturnValue("https://example.com/");
	(page as any).evaluate = vi.fn().mockResolvedValue("");
	(page as any).ariaSnapshot = vi
		.fn()
		.mockResolvedValue("- root [Root] mock aria tree");
	(page as any).close = vi.fn();
	(page as any).keyboard = {
		press: vi.fn(),
	};
	(page as any).screenshot = vi.fn().mockResolvedValue(Buffer.from(""));
	return page;
}

/**
 * Create a mock Playwright Browser.
 * Fires 'disconnected' when told via `.emitDisconnect()`.
 */
function createMockBrowser(): EventEmitter & {
	emitDisconnect: () => void;
	handlerCount: () => number;
} {
	const browser = new EventEmitter() as EventEmitter & {
		emitDisconnect: () => void;
		handlerCount: () => number;
	};
	(browser as any).newContext = vi.fn<() => EventEmitter>(() =>
		createMockContext(),
	);
	(browser as any).close = vi.fn();
	/**
	 * Helper to simulate a browser disconnect event.
	 * Playwright's Browser fires 'disconnected' when the browser process
	 * exits or the WebSocket connection drops.
	 */
	browser.emitDisconnect = () => {
		browser.emit("disconnected");
	};
	/**
	 * Return the number of 'disconnected' listeners on this browser.
	 * Used in the handler-nesting assertion.
	 */
	browser.handlerCount = () => browser.listenerCount("disconnected");
	return browser;
}

// ─── Testable plugin subclass ─────────────────────────────────────

class TestableFirefoxPlugin extends PlaywrightPluginBase {
	readonly name = "testable-firefox";
	readonly capabilities: PluginCapabilities = {
		...DEFAULT_CAPABILITIES,
		engine: "firefox",
	};
	protected readonly captureUserAgent = false;

	/** Hardcoded fallback UA — never used since captureUserAgent is false. */
	protected get userAgent(): string {
		return "testable-firefox-mock";
	}

	protected get installHint(): string {
		return "Install mock browser for testing";
	}

	// ── Expose protected state for assertions ──────────────────────────

	get cdpEndpoint(): string | null {
		return this._cdpEndpoint;
	}

	// ── Reconnect tracking ────────────────────────────────────────────

	/** Number of times _reconnectBrowser() has been called. */
	reconnectCount = 0;

	/** The mock Browser instances created, in order, for handler inspection. */
	browsers: Array<
		EventEmitter & { emitDisconnect: () => void; handlerCount: () => number }
	> = [];

	// ── Plugin contract overrides ────────────────────────────────────

	protected async launchBrowser(): Promise<any> {
		const server = new EventEmitter();
		(server as any).wsEndpoint = vi.fn().mockReturnValue("ws://test-endpoint");
		(server as any).close = vi.fn();
		this._browserServer = server as any;
		this._wsEndpoint = "ws://test-endpoint";

		const browser = createMockBrowser();
		this.browsers.push(browser);
		return browser as any;
	}

	protected async _reconnectBrowser(): Promise<any> {
		this.reconnectCount++;
		const browser = createMockBrowser();
		this.browsers.push(browser);
		return browser as any;
	}

	getAttachEndpoint(): AttachEndpoint | null {
		return this._wsEndpoint
			? { kind: "firefox-ws", endpoint: this._wsEndpoint }
			: null;
	}
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("PlaywrightPluginBase — launchServer reconnect (firefox-ws)", () => {
	let plugin: TestableFirefoxPlugin;

	beforeEach(() => {
		plugin = new TestableFirefoxPlugin();
	});

	afterEach(async () => {
		await plugin.cleanupAll().catch(() => {});
	});

	// ── Basic endpoint lifecycle ──────────────────────────────────────

	it("getAttachEndpoint returns null before any navigation", () => {
		expect(plugin.getAttachEndpoint()).toBeNull();
	});

	it("getAttachEndpoint returns valid endpoint after navigate", async () => {
		const result = await plugin.navigate(
			"https://example.com/",
			"task-basic",
			10_000,
		);
		expect(result.success).toBe(true);

		const endpoint = plugin.getAttachEndpoint();
		expect(endpoint).toEqual({
			kind: "firefox-ws",
			endpoint: "ws://test-endpoint",
		});
	});

	// ── Disconnect + reconnect behavior ───────────────────────────────

	it("cleans up _cdpEndpoint on disconnect", async () => {
		await plugin.navigate("https://example.com/", "task-cdp", 10_000);

		// _cdpEndpoint starts as null for firefox (no CDP) — but the
		// common cleanup path nulls it regardless.
		expect(plugin.cdpEndpoint).toBeNull();

		// Trigger disconnect
		const b0 = plugin.browsers[0]!;
		b0.emitDisconnect();

		// Allow microtasks to settle (the reconnect promise chain)
		await vi.waitFor(() => {
			expect(plugin.reconnectCount).toBe(1);
		});

		// Still null after cleanup (cdpEndpoint is always nulled on disconnect)
		expect(plugin.cdpEndpoint).toBeNull();
	});

	it("calls _reconnectBrowser and preserves wsEndpoint on disconnect", async () => {
		await plugin.navigate("https://example.com/", "task-recon", 10_000);
		expect(plugin.reconnectCount).toBe(0);

		// Trigger disconnect
		const b0 = plugin.browsers[0]!;
		b0.emitDisconnect();

		// Wait for reconnect to complete
		await vi.waitFor(() => {
			expect(plugin.reconnectCount).toBe(1);
		});

		// wsEndpoint is preserved (the server stays up)
		const endpoint = plugin.getAttachEndpoint();
		expect(endpoint).toEqual({
			kind: "firefox-ws",
			endpoint: "ws://test-endpoint",
		});
	});

	it("marks sessions as crashed and clears element cache on disconnect", async () => {
		await plugin.navigate("https://example.com/", "task-crash", 10_000);

		// Create a session the way the router would
		sessionManager.createSession("task-crash", "testable-firefox");

		// Element cache should exist for the task after navigate
		expect(plugin.getElementCache("task-crash")).not.toBeNull();

		// Trigger disconnect
		const b0 = plugin.browsers[0]!;
		b0.emitDisconnect();

		await vi.waitFor(() => {
			expect(plugin.reconnectCount).toBe(1);
		});

		// Session should be marked crashed
		const session = sessionManager.getSession("task-crash");
		expect(session?.crashed).toBe(true);

		// Element cache should be cleared
		expect(plugin.getElementCache("task-crash")).toBeNull();
	});

	it("navigate works after disconnect + reconnect", async () => {
		// First navigation
		const r1 = await plugin.navigate(
			"https://example.com/first",
			"task-a",
			10_000,
		);
		expect(r1.success).toBe(true);
		expect(plugin.reconnectCount).toBe(0);

		// Disconnect
		plugin.browsers[0]!.emitDisconnect();
		await vi.waitFor(() => {
			expect(plugin.reconnectCount).toBe(1);
		});

		// Second navigation (should create fresh context on reconnected browser)
		const r2 = await plugin.navigate(
			"https://example.com/second",
			"task-b",
			10_000,
		);
		expect(r2.success).toBe(true);
	});

	it("survives multiple consecutive disconnects", async () => {
		// Navigate → disconnect → reconnect × 3
		for (let i = 0; i < 3; i++) {
			const taskId = `task-multi-${i}`;
			const r = await plugin.navigate(
				`https://example.com/page${i}`,
				taskId,
				10_000,
			);
			expect(r.success).toBe(true);

			// Disconnect the current browser
			const browser = plugin.browsers[plugin.reconnectCount]!;
			browser.emitDisconnect();
			await vi.waitFor(() => {
				expect(plugin.reconnectCount).toBe(i + 1);
			});

			// Endpoint preserved
			expect(plugin.getAttachEndpoint()).toEqual({
				kind: "firefox-ws",
				endpoint: "ws://test-endpoint",
			});
		}
	});

	// ── Handler nesting assertion ─────────────────────────────────────

	it("installs exactly one disconnected handler per browser", async () => {
		await plugin.navigate("https://example.com/", "task-handler", 10_000);

		// B0: initial browser — should have exactly 1 handler
		expect(plugin.browsers[0]!.handlerCount()).toBe(1);

		// Disconnect → reconnect
		plugin.browsers[0]!.emitDisconnect();
		await vi.waitFor(() => {
			expect(plugin.reconnectCount).toBe(1);
		});

		// B0 is disconnected, B1 is the reconnected browser
		// B1 should also have exactly 1 handler
		expect(plugin.browsers[1]!.handlerCount()).toBe(1);

		// Disconnect B1 → reconnect again
		plugin.browsers[1]!.emitDisconnect();
		await vi.waitFor(() => {
			expect(plugin.reconnectCount).toBe(2);
		});

		// B2 should have exactly 1 handler as well
		expect(plugin.browsers[2]!.handlerCount()).toBe(1);

		// Total browsers created: 3 (B0 initial, B1 after reconnect, B2 after second reconnect)
		expect(plugin.browsers.length).toBe(3);
	});
});
