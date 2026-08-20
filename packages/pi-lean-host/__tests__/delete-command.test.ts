/**
 * /api delete command tests — temp api-guides dir fixture (no network).
 *
 * Covers the D10 acceptance bar:
 *  - whole-domain delete → interactive confirm, directory gone + cache
 *    invalidated (next catalog lookup empty — the ghost-guide fix).
 *  - single-guide delete (guide selector) → no confirm, that directory gone,
 *    siblings intact, cache invalidated.
 *  - non-existent → not-found message, nothing removed.
 *  - N-guide no-selector → D12 disambiguation menu, nothing removed.
 *  - malformed-guide literal-dir fallback (findGuidesByDomain can't address
 *    an unparseable guide) → whole-domain delete of the literal dirName.
 *  - cancelled confirm → nothing removed; path-traversal guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	setUserGuidesDir,
	invalidateCache,
	findGuidesByDomain,
	loadAllGuides,
} from "../core/guide-store.js";
import { handleDeleteSubcommand } from "../core/delete-command.js";

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

function recipe(domain: string, shortName: string): string {
	return `---
kind: api
domains: [${domain}]
icon: ✅
shortName: ${shortName}
apiHost: https://${domain}
operations:
  - name: get
    via: restGet
    path: /x
    accept: json
---
`;
}

let tmpGuidesDir: string;

beforeEach(() => {
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-delete-"));
	setUserGuidesDir(tmpGuidesDir);
	invalidateCache();
});

afterEach(() => {
	rmSync(tmpGuidesDir, { recursive: true, force: true });
});

function setupGuide(dirName: string, recipeText: string): void {
	const dir = join(tmpGuidesDir, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), recipeText, "utf-8");
	invalidateCache();
}

function mockCtx(overrides: Record<string, unknown> = {}): any {
	return {
		ui: { notify: vi.fn(), confirm: vi.fn(() => true) },
		hasUI: true,
		...overrides,
	};
}

function notifyText(ctx: any): string {
	return ctx.ui.notify.mock.calls.map((c: unknown[]) => c[0]).join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Whole-domain delete (confirm)
// ═══════════════════════════════════════════════════════════════════

describe("/api delete — whole-domain (confirm)", () => {
	it("confirms, removes the directory, and invalidates the cache", async () => {
		setupGuide("delete.test", recipe("delete.test", "Delete"));
		const ctx = mockCtx();
		await handleDeleteSubcommand("delete.test", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalled();
		expect(existsSync(join(tmpGuidesDir, "delete.test"))).toBe(false);
		expect(notifyText(ctx)).toContain("Deleted API guide 'delete.test'");
		// Cache invalidated — the next lookup sees nothing (ghost-guide fix).
		expect(findGuidesByDomain("delete.test")).toEqual([]);
		expect(loadAllGuides().guides["delete.test"]).toBeUndefined();
	});

	it("removes nothing when the confirm is cancelled", async () => {
		setupGuide("delete.test", recipe("delete.test", "Delete"));
		const ctx = mockCtx({ ui: { notify: vi.fn(), confirm: vi.fn(() => false) } });
		await handleDeleteSubcommand("delete.test", ctx);

		expect(notifyText(ctx)).toContain("Cancelled — nothing deleted.");
		expect(existsSync(join(tmpGuidesDir, "delete.test"))).toBe(true);
	});

	it("headless (no UI) skips the confirm and deletes", async () => {
		setupGuide("delete.test", recipe("delete.test", "Delete"));
		const ctx = mockCtx({ hasUI: false });
		await handleDeleteSubcommand("delete.test", ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(existsSync(join(tmpGuidesDir, "delete.test"))).toBe(false);
	});
});

// ═��═════════════════════════════════════════════════════════════════
// Single-guide delete (guide selector, no confirm)
// ═══════════════════════════════════════════════════════════════════

describe("/api delete — single-guide (selector)", () => {
	it("deletes one guide by shortName with no confirm, siblings intact", async () => {
		// Two guides claim the same domain (multi-recipe), different dirs.
		setupGuide("multi-a", recipe("multi.example", "Alpha"));
		setupGuide("multi-b", recipe("multi.example", "Beta"));
		const ctx = mockCtx();
		await handleDeleteSubcommand("multi.example beta", ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(existsSync(join(tmpGuidesDir, "multi-b"))).toBe(false);
		expect(existsSync(join(tmpGuidesDir, "multi-a"))).toBe(true);
		expect(notifyText(ctx)).toContain("Deleted API guide 'multi-b'");
		// Sibling still resolvable after cache invalidation.
		expect(findGuidesByDomain("multi.example").map((m) => m.dirName)).toEqual([
			"multi-a",
		]);
	});

	it("reports a no-match selector and removes nothing", async () => {
		setupGuide("multi-a", recipe("multi.example", "Alpha"));
		setupGuide("multi-b", recipe("multi.example", "Beta"));
		const ctx = mockCtx();
		await handleDeleteSubcommand("multi.example nope", ctx);

		expect(notifyText(ctx)).toContain("No guide named 'nope'");
		expect(existsSync(join(tmpGuidesDir, "multi-a"))).toBe(true);
		expect(existsSync(join(tmpGuidesDir, "multi-b"))).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Not-found + disambiguation + malformed fallback
// ═══════════════════════════════════════════════════════════════════

describe("/api delete — not-found / menu / malformed fallback", () => {
	it("reports not-found for a non-existent domain and removes nothing", async () => {
		const ctx = mockCtx();
		await handleDeleteSubcommand("ghost.example", ctx);

		expect(notifyText(ctx)).toContain("No API guide for 'ghost.example'");
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("returns the disambiguation menu for an N-guide domain with no selector", async () => {
		setupGuide("multi-a", recipe("multi.example", "Alpha"));
		setupGuide("multi-b", recipe("multi.example", "Beta"));
		const ctx = mockCtx();
		await handleDeleteSubcommand("multi.example", ctx);

		const text = notifyText(ctx);
		expect(text).toContain("2 API guides for 'multi.example'");
		expect(text).toContain("Alpha");
		expect(text).toContain("Beta");
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(existsSync(join(tmpGuidesDir, "multi-a"))).toBe(true);
		expect(existsSync(join(tmpGuidesDir, "multi-b"))).toBe(true);
	});

	it("deletes a malformed guide by its literal dirName (unreadable domains block)", async () => {
		// A guide whose frontmatter won't parse — findGuidesByDomain can't
		// address it by routing domain, but the malformed catalog line shows
		// the dirName, so /api delete <dirName> recovers it.
		mkdirSync(join(tmpGuidesDir, "broken.example"), { recursive: true });
		writeFileSync(
			join(tmpGuidesDir, "broken.example", "guide.md"),
			"---\nkind: api\ndomains: [broken.example]\nshortName: Broken\napiHost: https://broken.example\noperations:\n  - name: get\n    via: bogus\n    path: /x\n    accept: json\n---\n",
			"utf-8",
		);
		invalidateCache();
		// Sanity: the malformed guide is NOT resolvable by routing domain.
		expect(findGuidesByDomain("broken.example")).toEqual([]);

		const ctx = mockCtx();
		await handleDeleteSubcommand("broken.example", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalled();
		expect(existsSync(join(tmpGuidesDir, "broken.example"))).toBe(false);
		expect(notifyText(ctx)).toContain("Deleted API guide 'broken.example'");
	});

	it("rejects a path-traversal domain before any filesystem access", async () => {
		const ctx = mockCtx();
		await handleDeleteSubcommand("../../etc", ctx);

		expect(notifyText(ctx)).toContain("Invalid domain");
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});
});
