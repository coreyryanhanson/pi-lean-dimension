/**
 * BOE recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the actual BOE open-data API: parses the recipe, executes every
 * defined operation against the live endpoint, and asserts the response
 * has the expected shape.
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1.
 * Co-located with the guide and helper it tests.
 */

import { describe, expect } from "vitest";
import {
	withTempDirs,
	createFetchOp,
	itWhen,
} from "../_shared/test-harness.js";

const DOMAIN = "boe.es";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

// ═══════════════════════════════════════════════════════════════════
// BOE baseline: parse, listConsolidada, getConsolidada, getSumario
// ═══════════════════════════════════════════════════════════════════

describe("BOE live integration smoke", () => {
	itWhen(
		"parses and loads the BOE recipe from a temp user dir",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("boe.es");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["boe.es"]!;
			expect(guide.apiHost).toBe("https://www.boe.es");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(17);
		}),
	);

	itWhen(
		"listConsolidada fetches first page via the declared paginate executor",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listConsolidada")) as {
				items: unknown[];
			};
			// `paginate` returns an accumulated items array (offset-limit, non-gatherAll
			// defaults to a single page), not the raw `{status, data}` envelope. The
			// page size comes from the guide's pagination config (50), not caller params.
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getConsolidada fetches XML from the live BOE endpoint",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getConsolidada", {
				id: "BOE-A-2021-21346",
			})) as { data: unknown };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		20_000,
	);

	itWhen(
		"getSumario fetches diary summary from the live BOE endpoint",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSumario", {
				fecha: "20250101",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
			expect(result.data["status"]).toBeTruthy();
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — BORME sumario
// ═══════════════════════════════════════════════════════════════════

describe("BOE Group A — BORME sumario", () => {
	itWhen(
		"getSumarioBorme fetches BORME diary summary for a known publication date",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSumarioBorme", {
				fecha: "20250102",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["status"]).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getSumarioBorme returns 404 for a non-publication date",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const { HelperError } = await import("../../core/helpers.js");
			await expect(
				fetchOp(guidesDir, "getSumarioBorme", { fecha: "20250101" }),
			).rejects.toThrow(HelperError);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Consolidada sub-resources
// ═══════════════════════════════════════════════════════════════════

describe("BOE Group B — consolidada sub-resources", () => {
	itWhen(
		"getConsolidadaMetadatos returns JSON metadata for a known norm",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getConsolidadaMetadatos", {
				id: "BOE-A-2021-21346",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["status"]).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getConsolidadaAnalisis returns JSON analysis for a known norm",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getConsolidadaAnalisis", {
				id: "BOE-A-2021-21346",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["status"]).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getConsolidadaTextoIndice returns JSON index for a known norm",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getConsolidadaTextoIndice", {
				id: "BOE-A-2021-21346",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["status"]).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"getConsolidadaMetadataEli returns XML ELI metadata for a known norm",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getConsolidadaMetadataEli", {
				id: "BOE-A-2021-21346",
			})) as { data: unknown };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		20_000,
	);

	itWhen(
		"getConsolidadaTexto returns XML full text for a known norm",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getConsolidadaTexto", {
				id: "BOE-A-2021-21346",
			})) as { data: unknown };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		20_000,
	);

	itWhen(
		"getConsolidadaTextoBloque returns XML for a block id obtained from the index",
		withTempDirs("boe.es")(async ({ guidesDir }) => {
			// Obtain a valid id_bloque from the index first.
			const index = (await fetchOp(guidesDir, "getConsolidadaTextoIndice", {
				id: "BOE-A-2021-21346",
			})) as { data: { data?: unknown[] } };
			const blockIds: unknown[] = [];
			for (const item of index.data["data"] ?? []) {
				const nested = (item as Record<string, unknown>)["bloque"] as
					| { id?: unknown }[]
					| undefined;
				if (Array.isArray(nested)) {
					for (const b of nested) if (b?.id) blockIds.push(b.id);
				}
			}
			expect(blockIds.length).toBeGreaterThan(0);
			const result = (await fetchOp(guidesDir, "getConsolidadaTextoBloque", {
				id: "BOE-A-2021-21346",
				id_bloque: blockIds[0],
			})) as { data: unknown };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Auxiliary lookup tables
// ═══════════════════════════════════════════════════════════════════

describe("BOE Group C — auxiliary lookup tables", () => {
	const AUX_TABLES = [
		"listMaterias",
		"listAmbitos",
		"listEstadosConsolidacion",
		"listDepartamentos",
		"listRangos",
		"listRelacionesAnteriores",
		"listRelacionesPosteriores",
	] as const;

	for (const name of AUX_TABLES) {
		itWhen(
			`${name} returns a non-empty code→text map`,
			withTempDirs("boe.es")(async ({ guidesDir }) => {
				const result = (await fetchOp(guidesDir, name)) as {
					data: Record<string, unknown>;
				};
				expect(result.data).toBeTruthy();
				expect(result.data["status"]).toBeTruthy();
				// The aux tables return `data` as a code→text MAP object (not an
				// array) — the live response shape, verified 2026-08. See plan's
				// "Implementation notes" for the drift record.
				const data = result.data["data"];
				expect(typeof data).toBe("object");
				expect(data).not.toBeNull();
				expect(Array.isArray(data)).toBe(false);
				expect(Object.keys(data as object).length).toBeGreaterThan(0);
			}),
			20_000,
		);
	}
});
