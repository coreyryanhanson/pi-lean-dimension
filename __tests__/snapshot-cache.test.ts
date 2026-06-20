/**
 * Snapshot Disk Cache tests — Phase 1 of the browser-intelligence plan.
 *
 * All tests are browser-free — no Chromium needed.
 * Cleanup of temp files happens in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
	cacheSnapshot,
	removeSnapshotFiles,
	removeAllSnapshotFiles,
	formatCacheNotice,
	type CacheResult,
} from "../core/shared/snapshot-cache.js";
import { snapshotFingerprint } from "../core/shared/accessibility-tree.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** A snapshot shorter than the truncation threshold (2800). */
function shortSnapshot(): string {
	return "- tree [test] button " + "ok ".repeat(200).trim();
}

/** A snapshot longer than the truncation threshold (2800). */
function longSnapshot(): string {
	return "- tree [test] content " + "word ".repeat(800).trim();
}

/** A long snapshot that generates a distinct fingerprint. */
function otherLongSnapshot(): string {
	return "- tree [other] different " + "data ".repeat(800).trim();
}

/** Clean up all snapshot temp files between tests. */
function cleanCacheDir(): void {
	removeAllSnapshotFiles();
}

// ─── 1. cacheSnapshot() — basic caching ───────────────────────────────

describe("cacheSnapshot() — basic caching", () => {
	beforeEach(() => {
		cleanCacheDir();
	});

	afterEach(() => {
		cleanCacheDir();
	});

	it("caches a long snapshot (>2800 chars)", () => {
		const snap = longSnapshot();
		const fp = snapshotFingerprint(snap);
		const result = cacheSnapshot("test-task", snap, fp);

		expect(result).not.toBeNull();
		expect(result!.path).toMatch(/snapshot-test-task-/);
		expect(result!.fingerprint).toBe(fp);

		// File must exist on disk
		expect(existsSync(result!.path)).toBe(true);
		expect(readFileSync(result!.path, "utf-8")).toBe(snap);
	});

	it("does not cache a short snapshot (<2800 chars)", () => {
		const snap = shortSnapshot();
		const fp = snapshotFingerprint(snap);
		const result = cacheSnapshot("test-task", snap, fp);

		expect(result).toBeNull();
	});

	it("gracefully handles empty snapshot (below threshold)", () => {
		const result = cacheSnapshot("test-task", "", "empty");
		expect(result).toBeNull();
	});

	it("tolerates special characters in taskId", () => {
		const snap = longSnapshot();
		const fp = snapshotFingerprint(snap);
		const result = cacheSnapshot("browser-1/special:chars@test", snap, fp);

		expect(result).not.toBeNull();
		expect(result!.path).toMatch(/snapshot-browser-1_special_chars_test-/);
		expect(existsSync(result!.path)).toBe(true);
	});

	it("generates unique file paths for different fingerprints", () => {
		const snap1 = longSnapshot();
		const snap2 = otherLongSnapshot();
		const fp1 = snapshotFingerprint(snap1);
		const fp2 = snapshotFingerprint(snap2);

		const result1 = cacheSnapshot("task-unique", snap1, fp1);
		const result2 = cacheSnapshot("task-unique", snap2, fp2);

		expect(result1).not.toBeNull();
		expect(result2).not.toBeNull();
		expect(result1!.path).not.toBe(result2!.path);
		expect(existsSync(result1!.path)).toBe(true);
		expect(existsSync(result2!.path)).toBe(true);
	});
});

// ─── 2. cacheSnapshot() — eviction ────────────────────────────────────

describe("cacheSnapshot() — eviction", () => {
	beforeEach(() => {
		cleanCacheDir();
	});

	afterEach(() => {
		cleanCacheDir();
	});

	it("keeps at most MAX_FILES_PER_TASK files (2)", () => {
		const snap = longSnapshot();
		const fp = snapshotFingerprint(snap);

		// Cache 3 snapshots for the same task
		const result1 = cacheSnapshot("evict-task", snap, fp);
		const result2 = cacheSnapshot("evict-task", snap, fp);
		const result3 = cacheSnapshot("evict-task", snap, fp);

		expect(result1).not.toBeNull();
		expect(result2).not.toBeNull();
		expect(result3).not.toBeNull();

		// At most 2 should exist on disk
		let existingCount = 0;
		if (existsSync(result1!.path)) existingCount++;
		if (existsSync(result2!.path)) existingCount++;
		if (existsSync(result3!.path)) existingCount++;

		expect(existingCount).toBeLessThanOrEqual(2);
	});

	it("different taskIds get independent limits", () => {
		const snap = longSnapshot();
		const fp = snapshotFingerprint(snap);

		// Cache 3 for task A, 2 for task B
		const a1 = cacheSnapshot("task-A", snap, fp);
		const a2 = cacheSnapshot("task-A", snap, fp);
		const a3 = cacheSnapshot("task-A", snap, fp);

		const b1 = cacheSnapshot("task-B", snap, fp);
		const b2 = cacheSnapshot("task-B", snap, fp);

		// Task A: at most 2 files
		let aCount = 0;
		for (const r of [a1, a2, a3]) {
			if (r && existsSync(r.path)) aCount++;
		}
		expect(aCount).toBeLessThanOrEqual(2);

		// Task B: both should exist
		expect(b1).not.toBeNull();
		expect(b2).not.toBeNull();
		expect(existsSync(b1!.path)).toBe(true);
		expect(existsSync(b2!.path)).toBe(true);
	});
});

// ─── 3. removeSnapshotFiles() ─────────────────────────────────────────

describe("removeSnapshotFiles()", () => {
	beforeEach(() => {
		cleanCacheDir();
	});

	afterEach(() => {
		cleanCacheDir();
	});

	it("removes files for a specific task", () => {
		const snap = longSnapshot();
		const fp = snapshotFingerprint(snap);

		const aResult = cacheSnapshot("task-A", snap, fp);
		const bResult = cacheSnapshot("task-B", snap, fp);

		expect(aResult).not.toBeNull();
		expect(bResult).not.toBeNull();

		removeSnapshotFiles("task-A");

		expect(existsSync(aResult!.path)).toBe(false);
		expect(existsSync(bResult!.path)).toBe(true);
	});

	it("does not throw on non-existent taskId", () => {
		expect(() => removeSnapshotFiles("non-existent")).not.toThrow();
	});

	it("does not throw on already-removed files", () => {
		const snap = longSnapshot();
		const fp = snapshotFingerprint(snap);
		const result = cacheSnapshot("task-rm-twice", snap, fp);
		expect(result).not.toBeNull();

		removeSnapshotFiles("task-rm-twice");
		// Second call should be safe
		expect(() => removeSnapshotFiles("task-rm-twice")).not.toThrow();
	});
});

// ─── 4. removeAllSnapshotFiles() ──────────────────────────────────────

describe("removeAllSnapshotFiles()", () => {
	beforeEach(() => {
		cleanCacheDir();
	});

	afterEach(() => {
		cleanCacheDir();
	});

	it("removes all cached files across all tasks", () => {
		const snap = longSnapshot();
		const fp = snapshotFingerprint(snap);

		const r1 = cacheSnapshot("task-A", snap, fp);
		const r2 = cacheSnapshot("task-B", snap, fp);

		expect(r1).not.toBeNull();
		expect(r2).not.toBeNull();

		removeAllSnapshotFiles();

		expect(existsSync(r1!.path)).toBe(false);
		expect(existsSync(r2!.path)).toBe(false);
	});

	it("is safe to call when no files exist", () => {
		expect(() => removeAllSnapshotFiles()).not.toThrow();
	});

	it("is safe to call multiple times", () => {
		removeAllSnapshotFiles();
		removeAllSnapshotFiles();
		expect(() => removeAllSnapshotFiles()).not.toThrow();
	});
});

// ─── 5. formatCacheNotice() ────────────────────────────────────────────

describe("formatCacheNotice()", () => {
	it("returns cache notice when cache result exists and snapshot was truncated", () => {
		const cacheResult: CacheResult = {
			path: "/tmp/pi-browser/snapshot-test-abc123-0.txt",
			fingerprint: "abc123",
		};
		const notice = formatCacheNotice(cacheResult, 5000, true);
		expect(notice).toContain("Full snapshot cached at");
		expect(notice).toContain(cacheResult.path);
		expect(notice).toContain("use browser-inspect");
	});

	it("returns fallback hint when cacheResult is null but snapshot was truncated", () => {
		const notice = formatCacheNotice(null, 5000, true);
		expect(notice).toContain("use browser-inspect");
		expect(notice).toContain("full=true");
		expect(notice).not.toContain("Full snapshot cached at");
	});

	it("returns empty string when snapshot was not truncated", () => {
		const cacheResult: CacheResult = {
			path: "/tmp/pi-browser/snapshot-test-abc123-0.txt",
			fingerprint: "abc123",
		};
		const notice = formatCacheNotice(cacheResult, 100, false);
		expect(notice).toBe("");
	});

	it("returns empty string when snapshot is short even if truncated flag is true", () => {
		// This guards against the internal check in formatCacheNotice
		const cacheResult: CacheResult = {
			path: "/tmp/pi-browser/snapshot-test-abc123-0.txt",
			fingerprint: "abc123",
		};
		const notice = formatCacheNotice(cacheResult, 2000, true);
		expect(notice).toBe("");
	});

	it("returns empty string when not truncated and cacheResult is null", () => {
		const notice = formatCacheNotice(null, 100, false);
		expect(notice).toBe("");
	});

	it("includes the absolute file path in the notice", () => {
		const cacheResult: CacheResult = {
			path: "/tmp/pi-browser/snapshot-test-abc123-0.txt",
			fingerprint: "abc123",
		};
		const notice = formatCacheNotice(cacheResult, 5000, true);
		expect(notice).toMatch(/\/tmp\/pi-browser\/snapshot-/);
	});

	it("includes element count in cache notice when provided", () => {
		const cacheResult: CacheResult = {
			path: "/tmp/pi-browser/snapshot-test-abc123-0.txt",
			fingerprint: "abc123",
		};
		const notice = formatCacheNotice(cacheResult, 5000, true, 42);
		expect(notice).toContain("42 elements total");
		expect(notice).toContain("use browser-inspect");
	});

	it("omits element count line when count is zero in cache notice", () => {
		const cacheResult: CacheResult = {
			path: "/tmp/pi-browser/snapshot-test-abc123-0.txt",
			fingerprint: "abc123",
		};
		const notice = formatCacheNotice(cacheResult, 5000, true, 0);
		expect(notice).toContain("Full snapshot cached at");
		expect(notice).toContain("use browser-inspect");
		expect(notice).not.toContain("elements total");
	});

	it("fallback hint includes both browser-inspect and full=true guidance", () => {
		const notice = formatCacheNotice(null, 5000, true);
		expect(notice).toContain("use browser-inspect role=... name=...");
		expect(notice).toContain("use browser-snapshot full=true");
	});

	it("fallback hint returns empty when snapshot not truncated", () => {
		const notice = formatCacheNotice(null, 100, false);
		expect(notice).toBe("");
	});
});

// ─── 6. Integration: full cache-compact-notice flow (via MockPlugin) ──

describe("Integration: router + cache (via MockPlugin)", () => {
	beforeEach(async () => {
		const { pluginRegistry } = await import("../core/plugin-registry.js");
		const { default: _sm } = await import("../core/shared/session-manager.js");
		const { MockPlugin, makeConfig } = await import("./helpers/mock-plugin.js");
		pluginRegistry.clear();
		cleanCacheDir();

		const mock = new MockPlugin("mock");
		mock.navResult = {
			snapshot: longSnapshot(),
			elementCount: 400,
		};
		mock.interactResult = {
			snapshot: longSnapshot(),
			elementCount: 400,
		};
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));

		// Store mock on the test context
		(globalThis as any).__mockPlugin = mock;
	});

	afterEach(async () => {
		const { pluginRegistry } = await import("../core/plugin-registry.js");
		const { sessionManager } = await import(
			"../core/shared/session-manager.js"
		);
		await sessionManager.removeAll();
		pluginRegistry.clear();
		cleanCacheDir();
		delete (globalThis as any).__mockPlugin;
	});

	it("router.navigate() creates cache file and includes notice for long snapshots", async () => {
		const { navigate } = await import("../core/router.js");
		const result = await navigate("https://example.com", {
			strategy: "mock",
		});

		expect(result.success).toBe(true);
		expect(result.snapshot).toContain("Full snapshot cached at");
	});

	it("router.navigate() returns a cacheable file whose content matches the raw snapshot", async () => {
		const { navigate } = await import("../core/router.js");
		const result = await navigate("https://example.com", {
			strategy: "mock",
		});

		expect(result.success).toBe(true);

		// Extract the cache path from the notice
		const snapText = result.snapshot;
		expect(snapText).toBeDefined();
		const match = snapText!.match(/Full snapshot cached at (\/[^\s]+)/);
		expect(match).not.toBeNull();
		const cachePath = match![1]!;
		expect(existsSync(cachePath)).toBe(true);

		// Content should be the long snapshot
		const cached = readFileSync(cachePath, "utf-8");
		expect(cached).toBe(longSnapshot());
	});

	it("router.navigate() does NOT include cache notice for short snapshots", async () => {
		const { pluginRegistry } = await import("../core/plugin-registry.js");
		const { MockPlugin, makeConfig } = await import("./helpers/mock-plugin.js");
		pluginRegistry.clear();
		const mock = new MockPlugin("mock");
		mock.navResult = {
			snapshot: shortSnapshot(),
			elementCount: 200,
		};
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));

		const { navigate } = await import("../core/router.js");
		const result = await navigate("https://example.com", {
			strategy: "mock",
		});

		expect(result.success).toBe(true);
		expect(result.snapshot).not.toContain("Full snapshot cached at");
	});
});

// ─── 7. Interaction tool caching ─────────────────────────────────────

describe("Interaction tool caching (via MockPlugin)", () => {
	beforeEach(async () => {
		const { pluginRegistry } = await import("../core/plugin-registry.js");
		const { default: _sm } = await import("../core/shared/session-manager.js");
		const { MockPlugin, makeConfig } = await import("./helpers/mock-plugin.js");
		pluginRegistry.clear();
		cleanCacheDir();

		const mock = new MockPlugin("mock");
		mock.navResult = {
			snapshot: shortSnapshot(),
			elementCount: 200,
		};
		mock.interactResult = {
			snapshot: longSnapshot(),
			elementCount: 400,
		};
		pluginRegistry.register(mock, makeConfig({ name: "mock" }));

		(globalThis as any).__mockPlugin = mock;

		// First navigate to establish a session
		const { navigate } = await import("../core/router.js");
		await navigate("https://example.com", { strategy: "mock" });
	});

	afterEach(async () => {
		const { pluginRegistry } = await import("../core/plugin-registry.js");
		const { sessionManager } = await import(
			"../core/shared/session-manager.js"
		);
		await sessionManager.removeAll();
		pluginRegistry.clear();
		cleanCacheDir();
		delete (globalThis as any).__mockPlugin;
	});

	it("click result includes cache notice for long auto-snapshot", async () => {
		const { click } = await import("../core/router.js");
		const result = await click("default", "@e1");

		expect(result.success).toBe(true);
		expect(result.snapshot).toContain("Full snapshot cached at");
	});

	it("type result includes cache notice for long auto-snapshot", async () => {
		const { type } = await import("../core/router.js");
		const result = await type("default", "@e1", "hello");

		expect(result.success).toBe(true);
		expect(result.snapshot).toContain("Full snapshot cached at");
	});

	it("scroll result includes cache notice for long auto-snapshot", async () => {
		const { scroll } = await import("../core/router.js");
		const result = await scroll("default", "down");

		expect(result.success).toBe(true);
		expect(result.snapshot).toContain("Full snapshot cached at");
	});

	it("interaction cache file contains full snapshot content", async () => {
		const { click } = await import("../core/router.js");
		const result = await click("default", "@e1");

		expect(result.success).toBe(true);

		const snapText = result.snapshot ?? "";
		const match = snapText.match(/Full snapshot cached at (\/[^\s]+)/);
		expect(match).not.toBeNull();
		const cachePath = match![1]!;
		expect(existsSync(cachePath)).toBe(true);
		expect(readFileSync(cachePath, "utf-8")).toBe(longSnapshot());
	});

	it("interaction with short auto-snapshot does NOT include cache notice", async () => {
		const mock = (globalThis as any).__mockPlugin as any;
		// Override interactResult with short snapshot
		mock.interactResult = {
			snapshot: shortSnapshot(),
			elementCount: 200,
		};

		const { click } = await import("../core/router.js");
		const result = await click("default", "@e1");

		expect(result.success).toBe(true);
		expect(result.snapshot).not.toContain("Full snapshot cached at");
	});
});
