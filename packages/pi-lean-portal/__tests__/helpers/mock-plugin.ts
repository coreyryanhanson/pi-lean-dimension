/**
 * MockPlugin — fully-configurable BrowserPlugin fixture for testing.
 *
 * Every operation returns a success result by default; individual
 * methods can be overridden via `navResult`, `snapResult`, etc.
 * All calls are tracked in `calls` for assertion.
 */

import type {
	BrowserPlugin,
	PluginCapabilities,
	NavigateResult,
	SnapshotResult,
	InteractionResult,
	ScreenshotResult,
	ConsoleMessagesResult,
	EvaluateResult,
	CookieResult,
	ClearCookiesOptions,
	StorageStateResult,
	ResultBase,
} from "../../core/plugin-api.js";
import type { PluginConfig } from "../../core/plugin-config.js";
import { DEFAULT_CAPABILITIES } from "../../core/plugin-api.js";
import type { AriaCachedNode } from "../../core/shared/accessibility-tree.js";

export class MockPlugin implements BrowserPlugin {
	readonly name: string;
	readonly capabilities: PluginCapabilities;

	/** Track which methods were called and with what args */
	readonly calls: Map<string, unknown[]> = new Map();

	/** Per-operation configurable return values */
	navResult: Partial<NavigateResult> = {};
	snapResult: Partial<SnapshotResult> = {};
	interactResult: Partial<InteractionResult> = {};
	screenshotResult: Partial<ScreenshotResult> = {};
	consoleResult: Partial<ConsoleMessagesResult> = {};
	evalResult: Partial<EvaluateResult> = {};
	cookieResult: Partial<CookieResult> = {};
	addCookieResult: Partial<ResultBase> = {};
	clearCookieResult: Partial<ResultBase> = {};
	storageStateResult: Partial<StorageStateResult> = {};

	/** If set, this operation throws instead of returning */
	shouldThrow: Set<string> = new Set();

	/**
	 * Mock element cache (ref → AriaCachedNode) for browser-inspect tests.
	 * Default: empty. Tests can populate it with mock nodes.
	 */
	elementCache: Map<string, AriaCachedNode> = new Map();

	constructor(name = "mock", capabilities: Partial<PluginCapabilities> = {}) {
		this.name = name;
		this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
	}

	private record(op: string, args: unknown[]): void {
		const existing = this.calls.get(op) ?? [];
		existing.push(args);
		this.calls.set(op, existing);
	}

	async init(config?: Record<string, unknown>): Promise<void> {
		this.record("init", [config]);
		if (this.shouldThrow.has("init")) throw new Error("init failed");
	}

	async cleanupAll(): Promise<void> {
		this.record("cleanupAll", []);
		if (this.shouldThrow.has("cleanupAll"))
			throw new Error("cleanupAll failed");
	}

	async navigate(
		url: string,
		taskId: string,
		timeoutMs: number,
		options?: { signal?: AbortSignal; storageState?: unknown },
	): Promise<NavigateResult> {
		this.record("navigate", [url, taskId, timeoutMs, options]);
		if (this.shouldThrow.has("navigate")) throw new Error("navigate failed");
		return {
			success: true,
			url,
			title: "Mock Page",
			snapshot: "- tree [url] mock content",
			elementCount: 5,
			...this.navResult,
		};
	}

	async snapshot(taskId: string): Promise<SnapshotResult> {
		this.record("snapshot", [taskId]);
		if (this.shouldThrow.has("snapshot")) throw new Error("snapshot failed");
		return {
			success: true,
			snapshot: "- tree [mock] snapshot",
			elementCount: 3,
			...this.snapResult,
		};
	}

	async click(taskId: string, ref: string): Promise<InteractionResult> {
		this.record("click", [taskId, ref]);
		if (this.shouldThrow.has("click")) throw new Error("click failed");
		return {
			success: true,
			snapshot: "- tree [clicked]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async type(
		taskId: string,
		ref: string,
		text: string,
	): Promise<InteractionResult> {
		this.record("type", [taskId, ref, text]);
		if (this.shouldThrow.has("type")) throw new Error("type failed");
		return {
			success: true,
			snapshot: "- tree [typed]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async scroll(
		taskId: string,
		direction: "up" | "down",
	): Promise<InteractionResult> {
		this.record("scroll", [taskId, direction]);
		if (this.shouldThrow.has("scroll")) throw new Error("scroll failed");
		return {
			success: true,
			snapshot: "- tree [scrolled]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async goBack(taskId: string): Promise<InteractionResult> {
		this.record("goBack", [taskId]);
		if (this.shouldThrow.has("goBack")) throw new Error("goBack failed");
		return {
			success: true,
			newUrl: "https://example.com/prev",
			snapshot: "- tree [back]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async press(taskId: string, key: string): Promise<InteractionResult> {
		this.record("press", [taskId, key]);
		if (this.shouldThrow.has("press")) throw new Error("press failed");
		return {
			success: true,
			snapshot: "- tree [pressed]",
			elementCount: 3,
			...this.interactResult,
		};
	}

	async screenshot(
		taskId: string,
		options?: { fullPage?: boolean },
	): Promise<ScreenshotResult> {
		this.record("screenshot", [taskId, options]);
		if (this.shouldThrow.has("screenshot"))
			throw new Error("screenshot failed");
		return {
			success: true,
			dataUri: "data:image/jpeg;base64,mockdata",
			...this.screenshotResult,
		};
	}

	async getConsoleMessages(taskId: string): Promise<ConsoleMessagesResult> {
		this.record("getConsoleMessages", [taskId]);
		if (this.shouldThrow.has("getConsoleMessages"))
			throw new Error("getConsoleMessages failed");
		return {
			success: true,
			messages: [{ type: "log", text: "hello" }],
			...this.consoleResult,
		};
	}

	async clearConsole(taskId: string): Promise<void> {
		this.record("clearConsole", [taskId]);
		if (this.shouldThrow.has("clearConsole"))
			throw new Error("clearConsole failed");
	}

	async evaluate(taskId: string, expression: string): Promise<EvaluateResult> {
		this.record("evaluate", [taskId, expression]);
		if (this.shouldThrow.has("evaluate")) throw new Error("evaluate failed");
		return {
			success: true,
			result: 42,
			...this.evalResult,
		};
	}

	getElementCache(taskId: string): Map<string, AriaCachedNode> | null {
		this.record("getElementCache", [taskId]);
		if (this.shouldThrow.has("getElementCache"))
			throw new Error("getElementCache failed");
		return this.elementCache.size > 0 ? this.elementCache : null;
	}

	async cleanup(taskId: string): Promise<void> {
		this.record("cleanup", [taskId]);
		if (this.shouldThrow.has("cleanup")) throw new Error("cleanup failed");
	}

	async getCookies(taskId: string, urls?: string[]): Promise<CookieResult> {
		this.record("getCookies", [taskId, urls]);
		if (this.shouldThrow.has("getCookies"))
			throw new Error("getCookies failed");
		return {
			success: true,
			cookies: [
				{
					name: "mock",
					value: "value",
					domain: ".example.com",
					path: "/",
				},
			],
			...this.cookieResult,
		};
	}

	async addCookies(
		taskId: string,
		cookies: import("../../core/plugin-api.js").Cookie[],
	): Promise<ResultBase> {
		this.record("addCookies", [taskId, cookies]);
		if (this.shouldThrow.has("addCookies"))
			throw new Error("addCookies failed");
		return {
			success: true,
			...this.addCookieResult,
		};
	}

	async clearCookies(
		taskId: string,
		options?: ClearCookiesOptions,
	): Promise<ResultBase> {
		this.record("clearCookies", [taskId, options]);
		if (this.shouldThrow.has("clearCookies"))
			throw new Error("clearCookies failed");
		return {
			success: true,
			...this.clearCookieResult,
		};
	}

	async getStorageState(taskId: string): Promise<StorageStateResult> {
		this.record("getStorageState", [taskId]);
		if (this.shouldThrow.has("getStorageState"))
			throw new Error("getStorageState failed");
		return {
			success: true,
			cookies: [
				{
					name: "mock",
					value: "value",
					domain: ".example.com",
					path: "/",
				},
			],
			origins: [
				{
					origin: "https://example.com",
					localStorage: [],
				},
			],
			...this.storageStateResult,
		};
	}
}

/** Build a default PluginConfig for testing (with sensible defaults). */
export function makeConfig(
	overrides: Partial<PluginConfig> = {},
): PluginConfig {
	return {
		name: "mock",
		dir: "mock",
		enabled: true,
		config: {},
		...overrides,
	};
}
