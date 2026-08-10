/**
 * MusicBrainz recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every operation against the live endpoint, and
 * asserts the response has the expected shape (200 + non-empty body / expected
 * `itemsPath` for `paginate` ops / bare entity `id` for lookups / expected
 * `{plural}` list for the non-MBID lookups).
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

const DOMAIN = "musicbrainz.org";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; delay+retry wrapper stays here) ──

// MusicBrainz enforces a 1 req/sec rate limit for anonymous clients. The
// pipeline sends a descriptive UA (satisfies the UA requirement), but pace the
// 37-op live sweep to avoid 429s and the transient "server busy" 503s.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// MusicBrainz intermittently answers 503 `{"error": "... busy ..."}` under load.
// The pipeline surfaces that as a HelperError; the live gate treats it as
// transient and retries with backoff rather than failing a correct recipe.
async function isBusy503(e: unknown): Promise<boolean> {
	const { HelperError } = await import("../../core/helpers.js");
	return e instanceof HelperError && e.message.includes("Unexpected HTTP 503");
}

const _fetch = createFetchOp(DOMAIN);

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	await delay(1000);
	for (let attempt = 0; ; attempt++) {
		try {
			return _fetch(guidesDir, name, params);
		} catch (e) {
			if (attempt < 4 && (await isBusy503(e))) {
				await delay(3000 * (attempt + 1));
				continue;
			}
			throw e;
		}
	}
}

// ═══════════════════════════════════════════════════════════════════
// Baseline
// ═══════════════════════════════════════════════════════════════════

describe("MusicBrainz live integration smoke", () => {
	itWhen(
		"parses and loads the recipe with all 37 ops",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("musicbrainz.org");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["musicbrainz.org"]!;
			expect(guide.apiHost).toBe("https://musicbrainz.org");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(37);
		}),
	);

	itWhen(
		"searchArtists returns artists via the declared paginate executor",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchArtists", {
				query: "Nirvana",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Search (11 entities, identical offset-limit shape)
// ═══════════════════════════════════════════════════════════════════

describe("MusicBrainz Group A — search", () => {
	const SEARCHES: Array<[string, string]> = [
		["searchRecordings", "We Will Rock You"],
		["searchReleases", "Nevermind"],
		["searchReleaseGroups", "Thriller"],
		["searchLabels", "Warner Records"],
		["searchWorks", "Bohemian Rhapsody"],
		["searchAreas", "United States"],
		["searchEvents", "Live Aid"],
		["searchInstruments", "guitar"],
		["searchPlaces", "Abbey Road"],
		["searchSeries", "Peel Sessions"],
		["searchUrls", "discogs"],
	] as const;

	for (const [name, query] of SEARCHES) {
		itWhen(
			`${name} returns a non-empty items array`,
			withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
				const result = (await fetchOp(guidesDir, name, {
					query,
				})) as { items: unknown[] };
				expect(Array.isArray(result.items)).toBe(true);
				expect(result.items.length).toBeGreaterThan(0);
			}),
			30_000,
		);
	}
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Lookup (12 entities, bare entity object)
// ═══════════════════════════════════════════════════════════════════

describe("MusicBrainz Group B — lookup", () => {
	const LOOKUPS: Array<[string, string]> = [
		["getArtist", "5b11f4ce-a62d-471e-81fc-a69a8278c7da"], // Nirvana
		["getRecording", "2460a241-6ff4-49f1-80f9-36051534e9ae"], // Wanna Be Startin' Somethin'
		["getRelease", "3723c24b-a5a7-3295-b8ab-409a0650efac"], // Nevermind (1991)
		["getReleaseGroup", "f32fab67-77dd-3937-addc-9062e28e4c37"], // Thriller
		["getLabel", "d4cd174f-784d-48d7-91c6-7427bd5d57fe"], // Warner Records
		["getWork", "8fc1410a-81ac-342b-ae0a-66b9102c141a"], // Beat It
		["getArea", "489ce91b-6658-3307-9877-795b68554c98"], // United States
		["getEvent", "8e0ff16a-757f-4e16-9877-4c4131621a8b"], // Live Aid
		["getInstrument", "7ee8ebf5-3aed-4fc8-8004-49f4a8c45a87"], // electric guitar
		["getPlace", "26041c8e-aab6-4e57-bb4b-d2a7752de628"], // Abbey Road
		["getSeries", "2303dbba-cd4b-494a-a74b-d453a7477725"], // The Peel Sessions
		["getUrl", "508e1dc5-bd9e-46ee-a48d-0852fb715029"], // https://www.nirvana.com/
	] as const;

	for (const [name, mbid] of LOOKUPS) {
		itWhen(
			`${name} returns the bare entity with an id`,
			withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
				const result = (await fetchOp(guidesDir, name, {
					mbid,
				})) as { data: { id?: unknown } };
				expect(result.data).toBeTruthy();
				expect(typeof result.data).toBe("object");
				// JSON lookups return the entity object bare (top-level `id`),
				// not wrapped under an entity-named key.
				expect(result.data.id).toBeTruthy();
			}),
			30_000,
		);
	}
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Browse (7 linked-entity patterns)
// ═══════════════════════════════════════════════════════════════════

describe("MusicBrainz Group C — browse", () => {
	const NIRVANA = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";

	itWhen(
		"browseReleasesByArtist returns releases for Nirvana",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "browseReleasesByArtist", {
				artist: NIRVANA,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"browseRecordingsByRelease returns recordings for Nevermind",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "browseRecordingsByRelease", {
				release: "3723c24b-a5a7-3295-b8ab-409a0650efac",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"browseReleaseGroupsByArtist returns release-groups for Nirvana",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "browseReleaseGroupsByArtist", {
				artist: NIRVANA,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"browseReleasesByLabel returns releases for Warner Records",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "browseReleasesByLabel", {
				label: "d4cd174f-784d-48d7-91c6-7427bd5d57fe",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"browseRecordingsByArtist returns recordings for Nirvana",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "browseRecordingsByArtist", {
				artist: NIRVANA,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"browseWorksByArtist returns works for Nirvana",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "browseWorksByArtist", {
				artist: NIRVANA,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"browseReleasesByCollection returns releases for a public collection",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "browseReleasesByCollection", {
				// "Together Forever: Greatest Hits 1983–1991" — a public collection
				// (104 releases) found via editor Freso's profile; see plan notes.
				collection: "801df7ed-ffc4-4a0f-9351-ed0d5af4b079",
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Non-MBID lookups (discid / isrc / iswc)
// ═══════════════════════════════════════════════════════════════════

describe("MusicBrainz Group D — non-MBID lookups", () => {
	itWhen(
		"lookupDiscId returns a releases list for a known CD",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "lookupDiscId", {
				discid: "13oRY6ZM4e8BKBGbF.b.vug_zbA-", // Thriller (1983)
			})) as { data: { releases?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.releases)).toBe(true);
			expect((result.data.releases ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"lookupIsrc returns recordings for a known ISRC",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "lookupIsrc", {
				isrc: "USSM18200005", // Wanna Be Startin' Somethin'
			})) as { data: { recordings?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.recordings)).toBe(true);
			expect((result.data.recordings ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"lookupIswc returns works for a known ISWC",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "lookupIswc", {
				iswc: "T-070.232.940-5", // Beat It
			})) as { data: { works?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.works)).toBe(true);
			expect((result.data.works ?? []).length).toBeGreaterThan(0);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group E — URL by resource
// ═══════════════════════════════════════════════════════════════════

describe("MusicBrainz Group E — URL by resource", () => {
	itWhen(
		"lookupUrlByResource returns the URL entity for a known resource",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "lookupUrlByResource", {
				resource: "https://www.nirvana.com",
			})) as { data: { id?: unknown; resource?: unknown } };
			expect(result.data).toBeTruthy();
			expect(result.data.id).toBeTruthy();
			expect(result.data.resource).toBeTruthy();
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group F — Genre list
// ═══════════════════════════════════════════════════════════════════

describe("MusicBrainz Group F — genre list", () => {
	itWhen(
		"listAllGenres returns a non-empty genres array",
		withTempDirs("musicbrainz.org")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listAllGenres")) as {
				items: unknown[];
			};
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
		}),
		30_000,
	);
});
