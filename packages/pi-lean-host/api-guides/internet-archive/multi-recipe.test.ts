/**
 * archive.org synthetic axis guides — multi-recipe domains, mocked
 * transport. Covers the `multi-recipe-domains` axis guide-driven: two
 * axis guides (`internet-archive`, `wayback-availability`) claim the
 * `archive.org` domain, and `api-fetch`-style dispatch resolves an op by
 * name across all matches — exactly one hit executes (routed via that
 * guide's dirName, the helper-routing key); zero hits reports cleanly.
 *
 * Op-name collision is covered structurally by `__tests__/tools.test.ts`;
 * here we assert the kept on-disk pair has disjoint op names (no collision
 * in the union). No live endpoint.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import {
	findGuidesByDomain,
	setUserGuidesDir,
	invalidateCache,
} from "../../core/guide-store.js";

// Folder keys (slug(shortName)) for the two guides claiming archive.org.
const DOMAINS = ["internet-archive", "wayback-availability"] as const;

let tmpBase: string;

async function setupRecipe(): Promise<void> {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	for (const d of DOMAINS) {
		const dir = join(guidesDir, d);
		mkdirSync(dir, { recursive: true });
		// The test lives in api-guides/archive.org/, so the guide dirs are one
		// level up: ../<d>/guide.md.
		const source = readFileSync(
			new URL(`../${d}/guide.md`, import.meta.url),
			"utf-8",
		);
		writeFileSync(join(dir, "guide.md"), source, "utf-8");
	}
	setUserGuidesDir(guidesDir);
	invalidateCache();
}

/** Resolve an op across all guides claiming the domain — mirrors api-fetch. */
function resolveOp(
	domain: string,
	operation: string,
): { dirName: string; name: string }[] {
	const out: { dirName: string; name: string }[] = [];
	for (const { guide, dirName } of findGuidesByDomain(domain)) {
		const op = guide.operations.find((o) => o.name === operation);
		if (op) out.push({ dirName, name: op.name });
	}
	return out;
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-archive-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("archive.org multi-recipe dispatch (mocked transport)", () => {
	it("both axis guides claim the archive.org domain", async () => {
		await setupRecipe();
		const matches = findGuidesByDomain("archive.org");
		expect(matches.length).toBe(2);
		const dirs = matches.map((m) => m.dirName).sort();
		expect(dirs).toEqual(["internet-archive", "wayback-availability"]);
	});

	it("an op unique to archive.org dispatches via that guide", async () => {
		await setupRecipe();
		const hits = resolveOp("archive.org", "listSnapshots");
		expect(hits).toEqual([
			{ dirName: "internet-archive", name: "listSnapshots" },
		]);
	});

	it("an op unique to archive.org-wayback dispatches via that guide", async () => {
		await setupRecipe();
		const hits = resolveOp("archive.org", "getClosestSnapshot");
		expect(hits).toEqual([
			{ dirName: "wayback-availability", name: "getClosestSnapshot" },
		]);
	});

	it("a missing op reports zero hits cleanly", async () => {
		await setupRecipe();
		expect(resolveOp("archive.org", "doesNotExist")).toEqual([]);
	});

	it("the kept union has disjoint op names (no collision)", async () => {
		await setupRecipe();
		// wait for both guides in memory
		const names = findGuidesByDomain("archive.org").flatMap(({ guide }) =>
			guide.operations.map((o) => o.name),
		);
		expect(new Set(names).size).toBe(names.length);
	});
});
