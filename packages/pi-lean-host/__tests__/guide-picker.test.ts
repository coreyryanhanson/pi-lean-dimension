/**
 * Interactive guide picker (`core/guide-picker.ts`) — structural tests, no TUI.
 *
 * Covers:
 *  - the TUI gate: non-TUI contexts return undefined without calling custom
 *    (the headless/RPC/print fallback keeps today's text menu).
 *  - the pure row mapping: value=dirName, label=shortName (+ ⚠ when stale),
 *    description = guide description with an op-count fallback.
 *  - selection resolution: custom() resolving a value → the matching
 *    { guide, dirName }; resolving undefined (cancel) → undefined.
 */

import { describe, it, expect, vi } from "vitest";
import { buildGuidePickerItems, pickGuide } from "../core/guide-picker.js";
import { GUIDE_SCHEMA_VERSION } from "../core/api-guide-types.js";
import type { ApiGuide, Operation } from "../core/api-guide-types.js";

function guide(overrides: Partial<ApiGuide> = {}): ApiGuide {
	return {
		kind: "api",
		domains: ["multi.example"],
		shortName: "Alpha",
		apiHost: "https://multi.example",
		operations: [],
		schemaVersion: GUIDE_SCHEMA_VERSION,
		...overrides,
	} as ApiGuide;
}

/** Command-context fake, mirroring the other command test files. */
function mockCtx(overrides: Record<string, unknown> = {}): any {
	return { mode: "rpc", ui: { custom: vi.fn() }, ...overrides };
}

const MATCHES = [
	{
		guide: guide({ shortName: "Alpha", description: "Primary API" }),
		dirName: "multi-a",
	},
	{
		guide: guide({
			shortName: "Beta",
			operations: [{ name: "get" } as Operation],
		}),
		dirName: "multi-b",
	},
];

describe("buildGuidePickerItems", () => {
	it("maps dirName → value, shortName → label, description → second column", () => {
		const items = buildGuidePickerItems(MATCHES);
		expect(items).toEqual([
			{ value: "multi-a", label: "Alpha", description: "Primary API" },
			{ value: "multi-b", label: "Beta", description: "1 op" },
		]);
	});

	it("falls back to an op-count summary when description is absent", () => {
		const items = buildGuidePickerItems(MATCHES);
		expect(items[1]!.description).toBe("1 op");
	});

	it("omits description entirely when there is none and no ops", () => {
		const items = buildGuidePickerItems([
			{ guide: guide({ shortName: "Empty" }), dirName: "empty" },
		]);
		expect(items[0]).toEqual({ value: "empty", label: "Empty" });
	});

	it("flags a stale guide with a ⚠ on its label", () => {
		const stale = guide({ shortName: "Old", schemaVersion: 0 });
		const items = buildGuidePickerItems([{ guide: stale, dirName: "old" }], 1);
		expect(items[0]!.label).toBe("Old ⚠");
	});
});

describe("pickGuide", () => {
	it("returns undefined without calling custom in non-TUI mode", async () => {
		const ctx = mockCtx({ mode: "rpc" });
		expect(await pickGuide(ctx, MATCHES)).toBeUndefined();
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("resolves a picked value back to the matching guide in TUI mode", async () => {
		const ctx = mockCtx({
			mode: "tui",
			ui: { custom: vi.fn(async () => "multi-b") },
		});
		const result = await pickGuide(ctx, MATCHES);
		expect(result).toEqual({ guide: MATCHES[1]!.guide, dirName: "multi-b" });
	});

	it("returns undefined when the user cancels (custom resolves undefined)", async () => {
		const ctx = mockCtx({
			mode: "tui",
			ui: { custom: vi.fn(async () => undefined) },
		});
		expect(await pickGuide(ctx, MATCHES)).toBeUndefined();
	});
});
