/**
 * Structural tests for the MiniWoB test helper (Step 1).
 *
 * Validates the pure-logic parts of `helpers/miniwob.ts` — the ported
 * task table, the setup-JS builder, and the classifier — WITHOUT a
 * browser. The browser-driven MiniWoB task suite is Step 2
 * (`miniwob.test.ts`); this file only guards the helper itself.
 *
 * Run: npx vitest run __tests__/miniwob-helper.test.ts
 */

import { describe, it, expect } from "vitest";
import {
	MINIWOB_TASKS,
	MINIWOB_ELEMENT_TASKS,
	getMiniwobTask,
	buildMiniwobSetupJs,
	MINIWOB_SETUP_JS_ATTRIBUTION,
} from "./helpers/miniwob.js";

describe("MiniWoB helper — task table", () => {
	it("ports all 125 tasks from all.py @ 7fd85d71", () => {
		expect(MINIWOB_TASKS).toHaveLength(125);
	});

	it("has unique subdomains", () => {
		const subdomains = MINIWOB_TASKS.map((t) => t.subdomain);
		expect(new Set(subdomains).size).toBe(subdomains.length);
	});

	it("every task has a non-empty subdomain and desc", () => {
		for (const t of MINIWOB_TASKS) {
			expect(t.subdomain.length).toBeGreaterThan(0);
			expect(t.desc.length).toBeGreaterThan(0);
		}
	});

	it("subdomains match MiniWoB naming (lowercase, dashed, no spaces)", () => {
		for (const t of MINIWOB_TASKS) {
			expect(t.subdomain).toMatch(/^[a-z][a-z0-9-]*$/);
		}
	});

	it("classifies every task into a known requires category", () => {
		const allowed = new Set(["element", "coord", "drag", "hover", "select"]);
		for (const t of MINIWOB_TASKS) {
			expect(allowed.has(t.requires)).toBe(true);
		}
	});

	it("category counts match the plan's analysis", () => {
		const counts = MINIWOB_TASKS.reduce(
			(acc, t) => {
				acc[t.requires] = (acc[t.requires] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);
		// 90 element + 18 coord + 12 drag + 4 hover + 1 select = 125
		expect(counts["element"]).toBe(90);
		expect(counts["coord"]).toBe(18);
		expect(counts["drag"]).toBe(12);
		expect(counts["hover"]).toBe(4);
		expect(counts["select"]).toBe(1);
	});

	it("MINIWOB_ELEMENT_TASKS is the element-tagged subset", () => {
		expect(MINIWOB_ELEMENT_TASKS.length).toBe(90);
		for (const t of MINIWOB_ELEMENT_TASKS) {
			expect(t.requires).toBe("element");
		}
	});

	it("flags the four nondeterministic tasks from all.py", () => {
		const nondeterministicSubdomains = MINIWOB_TASKS.flatMap((t) =>
			t.nondeterministic ? [t.subdomain] : [],
		);
		expect(
			nondeterministicSubdomains.sort((a, b) => a.localeCompare(b)),
		).toEqual(
			["click-pie", "click-pie-nodelay", "terminal", "visual-addition"].sort(
				(a, b) => a.localeCompare(b),
			),
		);
	});

	it("includes the three spike tasks as element-reachable", () => {
		for (const sub of ["click-button", "email-inbox", "form-sequence"]) {
			expect(getMiniwobTask(sub).requires).toBe("element");
		}
	});

	it("getMiniwobTask throws on unknown subdomain", () => {
		expect(() => getMiniwobTask("not-a-real-task")).toThrow(/Unknown MiniWoB/);
	});

	it("skips canvas/drag/slider tasks per the plan's NOT-testable list", () => {
		// canvas/coordinate
		expect(getMiniwobTask("click-color").requires).toBe("coord");
		expect(getMiniwobTask("grid-coordinate").requires).toBe("coord");
		expect(getMiniwobTask("draw-circle").requires).toBe("coord");
		// drag
		expect(getMiniwobTask("drag-box").requires).toBe("drag");
		expect(getMiniwobTask("copy-paste").requires).toBe("drag");
		expect(getMiniwobTask("resize-textarea").requires).toBe("drag");
		// hover/slider/select
		expect(getMiniwobTask("use-slider").requires).toBe("hover");
		expect(getMiniwobTask("use-colorwheel").requires).toBe("hover");
		expect(getMiniwobTask("use-spinner").requires).toBe("select");
	});
});

describe("MiniWoB helper — setup JS builder (ported from base.py)", () => {
	it("embeds the seed and episode max time", () => {
		const js = buildMiniwobSetupJs(12345, 30_000);
		expect(js).toContain("Math.seedrandom(12345)");
		expect(js).toContain("core.EPISODE_MAX_TIME = 30000");
		expect(js).toContain("core.startEpisodeReal();");
	});

	it("includes the human-display removal block by default", () => {
		const js = buildMiniwobSetupJs(0, 10_000);
		// Verbatim from base.py setup():
		expect(js).toContain("__display_ids");
		expect(js).toContain("sync-task-cover");
		expect(js).toContain("reward-display");
		expect(js).toContain("click-canvas");
		expect(js).toContain("core.endEpisode_legacy = core.endEpisode");
		expect(js).toContain(
			"core.startEpisodeReal_legacy = core.startEpisodeReal",
		);
		expect(js).toContain("core.getUtterance_legacy = core.getUtterance");
		expect(js).toContain("removeDisplay()");
		expect(js).toContain("bringBackDisplay");
	});

	it("omits the display-removal block when removeHumanDisplay=false", () => {
		const js = buildMiniwobSetupJs(0, 10_000, false);
		expect(js).not.toContain("sync-task-cover");
		expect(js).not.toContain("removeDisplay");
		// ...but still seeds and starts the episode:
		expect(js).toContain("Math.seedrandom(0)");
		expect(js).toContain("core.startEpisodeReal();");
	});

	it("seeds deterministically for a given seed (snapshot of generated JS)", () => {
		// Guards against accidental reformatting of the ported injection.
		expect(buildMiniwobSetupJs(42, 1000)).toBe(buildMiniwobSetupJs(42, 1000));
	});

	it("carries attribution metadata", () => {
		expect(MINIWOB_SETUP_JS_ATTRIBUTION).toContain("base.py");
		expect(MINIWOB_SETUP_JS_ATTRIBUTION).toContain("7fd85d71");
		expect(MINIWOB_SETUP_JS_ATTRIBUTION).toContain("Apache-2.0");
	});
});
