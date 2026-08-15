/**
 * PubMed E-utilities recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the live NCBI E-utilities API (`https://eutils.ncbi.nlm.nih.gov/entrez/eutils`):
 * parses the recipe and executes every defined operation against the live endpoint.
 * The unique-DOI `esearch` assertion is the design-doc A1 proof — a query that
 * returns exactly one `<Id>` must box into a one-element array (third independent
 * A1 confirmation after arXiv and the framework axis-E unit fixture).
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

const DOMAIN = "ncbi.nlm.nih.gov"; // routing domain (the dir is eutils.ncbi.nlm.nih.gov)

// The routing domain is `ncbi.nlm.nih.gov` (guide.domains[0]) — api-fetch and
// the harness route by that, not by the dir name (`eutils.ncbi.nlm.nih.gov`).
const fetchOp = createFetchOp(DOMAIN);

// A real, permanent PMID (records are never deleted from PubMed).
const PMID = 42580705;
// A unique DOI (DOIs are unique → exactly one result, ever) — the stable
// single-`<Id>` trigger for the A1 boxing assertion. PubMed's `paginate`
// force-sets `retmax` from the op's `pageSize` (10), so the only reliable way
// to get a one-record page is a query whose total count is 1.
const UNIQUE_DOI_TERM = '"10.1038/s41586-020-2649-2"[doi]';
// A known-good citation for `ecitmatch` (docs example; returns PMID 2014248).
const CITATION = "proc natl acad sci u s a|1991|88|3248|mann bj|Art1|";

describe("PubMed E-utilities live integration smoke", () => {
	itWhen(
		"parses and loads the eutils recipe from a temp user dir",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("eutils.ncbi.nlm.nih.gov");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["eutils.ncbi.nlm.nih.gov"]!;
			expect(guide.apiHost).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils");
			expect(guide.auth.kind).toBe("static-key");
			expect(guide.auth.secretQueryRefs).toEqual({ api_key: "api_key" });
			expect(guide.auth.optional).toEqual(["api_key"]);
			expect(guide.operations.length).toBe(8);
		}),
	);

	itWhen(
		"esearch with a unique-DOI term boxes a single <Id> into a one-element array (A1, third API)",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "esearch", {
				term: UNIQUE_DOI_TERM,
			})) as { items: unknown[]; serverTotal?: number };
			// A1: a single `<Id>` must box into an array of length 1, not a bare scalar.
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items).toHaveLength(1);
			// totalCountPath `eSearchResult.Count` = 1 for a unique DOI.
			expect(result.serverTotal).toBe(1);
		}),
		20_000,
	);

	itWhen(
		"esearch returns a page of PMIDs with the total hit count surfaced",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "esearch", {
				term: "CRISPR",
			})) as { items: unknown[]; serverTotal?: number };
			expect(Array.isArray(result.items)).toBe(true);
			// pageSize 10 → a full first page of 10 PMIDs (array, no boxing needed).
			expect(result.items.length).toBe(10);
			// totalCountPath surfaces the server's total hit count.
			expect(result.serverTotal).toBeGreaterThan(0);
			for (const id of result.items) {
				expect(String(id)).toMatch(/^\d+$/);
			}
		}),
		20_000,
	);

	itWhen(
		"esummary returns a DocSum for a known PMID",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "esummary", {
				id: PMID,
			})) as { data: { eSummaryResult?: { DocSum?: { Id?: unknown } } } };
			expect(result.data.eSummaryResult).toBeTruthy();
			expect(result.data.eSummaryResult!.DocSum).toBeTruthy();
			expect(result.data.eSummaryResult!.DocSum!.Id).toBe(PMID);
		}),
		20_000,
	);

	itWhen(
		"efetch returns a full PubmedArticle for a known PMID",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "efetch", {
				id: PMID,
				rettype: "abstract",
			})) as {
				data: {
					PubmedArticleSet?: {
						PubmedArticle?: {
							MedlineCitation?: { PMID?: { "#text"?: unknown } };
						};
					};
				};
			};
			expect(result.data.PubmedArticleSet).toBeTruthy();
			expect(result.data.PubmedArticleSet!.PubmedArticle).toBeTruthy();
			expect(
				result.data.PubmedArticleSet!.PubmedArticle!.MedlineCitation!.PMID![
					"#text"
				],
			).toBe(PMID);
		}),
		20_000,
	);

	itWhen(
		"elink returns a LinkSet with neighbor links for a known PMID",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "elink", {
				id: PMID,
			})) as {
				data: {
					eLinkResult?: {
						LinkSet?: {
							IdList?: unknown;
							LinkSetDb?: unknown;
						};
					};
				};
			};
			expect(result.data.eLinkResult).toBeTruthy();
			expect(result.data.eLinkResult!.LinkSet).toBeTruthy();
			// The input UID is echoed in LinkSet.IdList; neighbor links sit in LinkSetDb.
			expect(result.data.eLinkResult!.LinkSet!.IdList).toBeTruthy();
			expect(result.data.eLinkResult!.LinkSet!.LinkSetDb).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"espell returns a spelling correction for a misspelled term",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "espell", {
				term: "Cambrige",
			})) as {
				data: { eSpellResult?: { CorrectedQuery?: unknown } };
			};
			expect(result.data.eSpellResult).toBeTruthy();
			expect(result.data.eSpellResult!.CorrectedQuery).toBeTruthy();
		}),
		20_000,
	);

	itWhen(
		"einfo returns database metadata for pubmed",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "einfo", {
				db: "pubmed",
			})) as {
				data: { eInfoResult?: { DbInfo?: { DbName?: unknown } } };
			};
			expect(result.data.eInfoResult).toBeTruthy();
			expect(result.data.eInfoResult!.DbInfo).toBeTruthy();
			expect(result.data.eInfoResult!.DbInfo!.DbName).toBe("pubmed");
		}),
		20_000,
	);

	itWhen(
		"ecitmatch returns raw text lines with matched PMIDs (format: text)",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "ecitmatch", {
				bdata: CITATION,
			})) as { data: string };
			// Raw text passthrough: the citation echoed back with the matched PMID.
			expect(typeof result.data).toBe("string");
			expect(result.data).toContain("proc natl acad sci u s a");
			expect(result.data).toContain("2014248");
		}),
		20_000,
	);

	itWhen(
		"two-step usehistory flow: esearch-raw tokens feed esummary via WebEnv/query_key",
		withTempDirs("eutils.ncbi.nlm.nih.gov")(async ({ guidesDir }) => {
			// Step 1: single-shot esearch with usehistory=y returns WebEnv/QueryKey.
			const search = (await fetchOp(guidesDir, "esearch-raw", {
				term: UNIQUE_DOI_TERM,
				usehistory: "y",
			})) as { data: { eSearchResult?: Record<string, unknown> } };
			const esr = search.data.eSearchResult!;
			const weNode = esr["WebEnv"] as { "#text"?: string } | string | undefined;
			const qkNode = esr["QueryKey"] as
				| { "#text"?: unknown }
				| string
				| number
				| undefined;
			const webenv = typeof weNode === "string" ? weNode : weNode?.["#text"];
			const queryKey = String(
				typeof qkNode === "object" ? qkNode?.["#text"] : qkNode,
			);
			expect(webenv).toBeTruthy();
			expect(queryKey).toBeTruthy();

			// Step 2: esummary consumes the history set via query_key+WebEnv (no id).
			const summary = (await fetchOp(guidesDir, "esummary", {
				query_key: queryKey,
				WebEnv: webenv,
			})) as { data: { eSummaryResult?: { DocSum?: { Id?: unknown } } } };
			expect(summary.data.eSummaryResult).toBeTruthy();
			expect(summary.data.eSummaryResult!.DocSum).toBeTruthy();
			// The unique-DOI history set holds exactly one record → a single DocSum.
			expect(String(summary.data.eSummaryResult!.DocSum!.Id)).toMatch(/^\d+$/);
		}),
		30_000,
	);
});
