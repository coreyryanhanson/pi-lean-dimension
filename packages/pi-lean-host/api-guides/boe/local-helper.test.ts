/**
 * boe synthetic axis guide — local-helper + XML, mocked transport.
 *
 * Covers the `local-helper` axis guide-driven: the op declares
 * `helper: true`, so `callHelper` runs the real `helper.ts` pre-call
 * (ISO date → BOE `aaaammdd`) before the request. Transport is mocked so
 * this runs in bare CI (no network). No live endpoint.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiGuide } from "../../core/api-guide-types.js";

// Mock the transport layer BEFORE any imports that use it.
vi.mock("../../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../../core/transport.js")>(
		"../../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { restGet } from "../../core/helpers.js";
import { callHelper } from "../../core/local-helpers.js";
import { stageGuides } from "../../__tests__/test-utils.js";

const XML_BODY = `<diarios><diario id="1"><titulo>Test diary</titulo></diario></diarios>`;

let tmpBase: string;

async function setupRecipe(): Promise<{ guide: ApiGuide }> {
	const { guides } = stageGuides(
		tmpBase,
		new URL("../", import.meta.url),
		["boe"],
		["guide.md", "helper.ts"],
	);
	return { guide: guides["boe"]! };
}

beforeAll(() => {
	tmpBase = mkdtempSync(join(tmpdir(), "pi-host-boe-axis-"));
});
afterAll(() => {
	rmSync(tmpBase, { recursive: true, force: true });
});

describe("boe local-helper through the real pipeline (mocked transport)", () => {
	it("callHelper converts an ISO fecha to aaaammdd before the request", async () => {
		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "searchDiary")!;
		expect(op.helper).toBe(true);

		const helped = await callHelper("boe", "searchDiary", {
			fecha: "2025-01-15",
		});
		expect(helped.ok).toBe(true);
		if (helped.ok) {
			expect(helped.params["fecha"]).toBe("20250115");
		}
	});

	it("callHelper passes through an already-aaaammdd fecha unchanged", async () => {
		const helped = await callHelper("boe", "searchDiary", {
			fecha: "20250115",
		});
		expect(helped.ok).toBe(true);
		if (helped.ok) {
			expect(helped.params["fecha"]).toBe("20250115");
		}
	});

	it("restGet executes searchDiary and parses the XML body (date converted by the helper)", async () => {
		const { fetchUrl } = await import("../../core/transport.js");
		vi.mocked(fetchUrl).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/xml;charset=UTF-8" },
			body: XML_BODY,
			cached: false,
		});

		const { guide } = await setupRecipe();
		const op = guide.operations.find((o) => o.name === "searchDiary")!;

		const helped = await callHelper("boe", "searchDiary", {
			fecha: "2025-01-15",
		});
		expect(helped.ok).toBe(true);
		if (!helped.ok) return; // TS narrowing

		const result = await restGet(guide.apiHost, op, helped.params, guide);
		const data = result.data as { diarios: unknown };
		expect(data["diarios"]).toBeTruthy();
		// The path param used the converted aaaammdd date.
		expect(result.url).toContain("/20250115");
	});
});
