/**
 * Federal Register recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the live Federal Register API v1: parses the recipe, executes every
 * defined operation against the live endpoint, and asserts the response has
 * the expected shape. Points at `/api/v1/*` JSON only — never the HTML
 * `/developers` site (reCAPTCHA wall, see ../WAF-NOTES.md).
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1.
 * Co-located with the guide it tests.
 */

import { describe, expect } from "vitest";
import {
	withTempDirs,
	createFetchOp,
	itWhen,
} from "../_shared/test-harness.js";

const DIR = "www.federalregister.gov";
const DOMAIN = "federalregister.gov";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper) ──

const fetchOp = createFetchOp(DOMAIN);

// Known-good, slash-free IDs probed live (2026-08). Document/PI numbers are
// real records; the image identifier comes from document 2026-11091's
// `images` field; the suggested-search slug is the object's own `slug`.
const TEST_DOC = "2026-11091";
const TEST_DOC2 = "2026-16125";
const TEST_AGENCY = "consumer-financial-protection-bureau";
const TEST_IMAGE = "EP03JN26.006";
const TEST_SUGGESTED_SEARCH = "dodd-frank-wall-steet-reform";
const TEST_PI_DOC = "2026-15961";
const TEST_PI_DOC2 = "2026-15989";
const TEST_ISSUE_DATE = "2024-01-02";

/**
 * Find the most recent date (from today, walking back up to 14 days) that has
 * Public Inspection documents, so the required `conditions[available_on]`
 * search has a non-empty page. PI docs are "currently on inspection" — a
 * weekend or pre-posting morning can be empty, so a fixed date is flaky.
 * Direct fetch against the API JSON is fine here (WAF-NOTES confirms the
 * `/api/v1/*` surface is reachable; the reCAPTCHA wall is HTML-only).
 */
async function findPiDateWithDocs(): Promise<string> {
	const d = new Date();
	for (let i = 0; i < 14; i++) {
		const iso = d.toISOString().slice(0, 10);
		const r = await fetch(
			`https://www.federalregister.gov/api/v1/public-inspection-documents.json?conditions%5Bavailable_on%5D=${iso}&per_page=1`,
			{ headers: { accept: "application/json" } },
		);
		if (r.ok) {
			const j = (await r.json()) as { count?: number };
			if ((j.count ?? 0) > 0) return iso;
		}
		d.setDate(d.getDate() - 1);
	}
	return new Date().toISOString().slice(0, 10); // fall back; assertion is best-effort
}

// ═══════════════════════════════════════════════════════════════════
// Parsing baseline + pre-existing op
// ═══════════════════════════════════════════════════════════════════

describe("Federal Register live integration smoke", () => {
	itWhen(
		"parses and loads the Federal Register recipe from a temp user dir",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("www.federalregister.gov");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["www.federalregister.gov"]!;
			expect(guide.apiHost).toBe("https://www.federalregister.gov");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(14);
		}),
	);

	itWhen(
		"listDocuments fetches a page via the declared paginate executor",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listDocuments")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Single-resource lookups
// ═══════════════════════════════════════════════════════════════════

describe("Federal Register Group A — single-resource lookups", () => {
	itWhen(
		"getDocument returns document_number and title for a real document",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getDocument", {
				document_number: TEST_DOC,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["document_number"]).toBe(TEST_DOC);
			expect(typeof result.data["title"]).toBe("string");
			expect(String(result.data["title"]).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getAgency returns name and slug for a real agency",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getAgency", {
				slug: TEST_AGENCY,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["slug"]).toBe(TEST_AGENCY);
			expect(typeof result.data["name"]).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"getImage returns image variants for a real identifier",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getImage", {
				identifier: TEST_IMAGE,
			})) as { data: Record<string, { url?: unknown }> };
			expect(result.data).toBeTruthy();
			for (const variant of ["large", "medium", "original_size"]) {
				// Each variant is an object {content_type, height, …, url, width}.
				expect(result.data[variant]).toBeTruthy();
				expect(typeof result.data[variant]).toBe("object");
				expect(typeof result.data[variant]?.["url"]).toBe("string");
			}
		}),
		20_000,
	);

	itWhen(
		"getSuggestedSearch returns a non-empty suggested-search object",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getSuggestedSearch", {
				slug: TEST_SUGGESTED_SEARCH,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data["title"]).toBe("string");
			expect(String(result.data["title"]).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — List/metadata endpoints
// ═════════════════════════════════════════════════════════════════════

describe("Federal Register Group B — list/metadata endpoints", () => {
	itWhen(
		"listAgencies returns the bare array of all agencies (> 400)",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listAgencies")) as {
				data: unknown[];
			};
			expect(Array.isArray(result.data)).toBe(true);
			expect(result.data.length).toBeGreaterThan(400);
		}),
		20_000,
	);

	itWhen(
		"listSuggestedSearches returns a non-empty object keyed by section",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listSuggestedSearches")) as {
				data: Record<string, unknown>;
			};
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
			expect(Array.isArray(result.data)).toBe(false);
			expect(Object.keys(result.data).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getDocumentFacets returns a non-empty object keyed by facet value",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getDocumentFacets", {
				facet: "agency",
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
			expect(Array.isArray(result.data)).toBe(false);
			expect(Object.keys(result.data).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Public Inspection Documents
// ═════════════════════════════════════════════════════════════════════

describe("Federal Register Group C — public inspection documents", () => {
	itWhen(
		"listPublicInspectionDocuments fetches a non-empty page via paginate",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const date = await findPiDateWithDocs();
			const result = (await fetchOp(
				guidesDir,
				"listPublicInspectionDocuments",
				{
					"conditions[available_on]": date,
				},
			)) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getCurrentPublicInspectionDocuments returns a non-empty results array",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(
				guidesDir,
				"getCurrentPublicInspectionDocuments",
			)) as { data: { results?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data["results"])).toBe(true);
			expect((result.data["results"] as unknown[]).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getPublicInspectionDocument returns a single PI doc",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPublicInspectionDocument", {
				document_number: TEST_PI_DOC,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["document_number"]).toBe(TEST_PI_DOC);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Issues / table of contents
// ═════════════════════════════════════════════════════════════════════

describe("Federal Register Group D — issues / TOC", () => {
	itWhen(
		"getIssue returns a non-empty agencies array for a print-edition date",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getIssue", {
				publication_date: TEST_ISSUE_DATE,
			})) as { data: { agencies?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data["agencies"])).toBe(true);
			expect((result.data["agencies"] as unknown[]).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group E — Multi-document batch fetch
// ═══════════════════════════════════════════════════════════════════

describe("Federal Register Group E — multi-document batch", () => {
	itWhen(
		"getDocuments returns results for comma-separated real document numbers",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getDocuments", {
				document_numbers: `${TEST_DOC},${TEST_DOC2}`,
			})) as { data: { results?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data["results"])).toBe(true);
			expect((result.data["results"] as unknown[]).length).toBeGreaterThan(0);
		}),
		20_000,
	);

	itWhen(
		"getPublicInspectionDocuments returns results for comma-separated PI numbers",
		withTempDirs(DIR)(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getPublicInspectionDocuments", {
				document_numbers: `${TEST_PI_DOC},${TEST_PI_DOC2}`,
			})) as { data: { results?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data["results"])).toBe(true);
			expect((result.data["results"] as unknown[]).length).toBeGreaterThan(0);
		}),
		20_000,
	);
});
