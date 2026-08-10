# GBIF API — Endpoint Coverage Plan

> Drafted 2026-07-20 against <https://techdocs.gbif.org/en/openapi/> (verified
> by browser navigation on 2026-07-20). Implements the read-only endpoints
> the current `guide.md` does not yet cover, across the **three highest-value
> API sections**: Species, Occurrence, and Literature.

## Status quo

`guide.md` declares **1 of ~35+** documented read-only GET endpoints
across the GBIF API surface:

| Operation | Path | `via` |
|-----------|------|-------|
| `listSpecies` | `GET /v1/species` (paged list) | `paginate` |

## Verification (2026-07-20)

The GBIF API reference lives at
[https://techdocs.gbif.org/en/openapi/](https://techdocs.gbif.org/en/openapi/).
Each API section has a corresponding OpenAPI 3.0/3.1 JSON spec available at
`https://techdocs.gbif.org/openapi/{name}.json`. Specs were fetched and live
probes run against `https://api.gbif.org/`.

**API sections documented (10 total):**

| Section | Has GET reads? | In scope? |
|---------|---------------|-----------|
| Registry API | Yes (datasets, orgs, nodes, networks) | ❌ — CRUD-heavy, admin-focused |
| Registry API (Principal methods) | Yes (subset of above) | ❌ — same data, Registry covers it |
| **Species API** | **Yes — 25+ GET endpoints** | ✅ |
| **Occurrence API** | **Yes — 12+ GET endpoints (+ downloads)** | ✅ (search + single record) |
| Occurrence Image API | Image proxy only (Thumbor) | ❌ — image cache, not data retrieval |
| **Maps API** | **Yes — tile/marker endpoints** | ❌ — image tiles, not structured data |
| **Literature API** | **Yes — 3 GET endpoints** | ✅ |
| Validator API | Mostly POST (validate datasets) | ❌ — mutation/upload |
| Vocabulary API | Yes — concept/vocabulary GETs | ❌ — enumerations, low research value |
| Analytics & Data Trends | Dashboard-style, no documented GETs | ❌ — no spec available |

### Species API — GET endpoints (all ✅ in scope)

From `/openapi/checklistbank.json` — 25 GET paths (POSTs excluded):

| # | Path | Summary | In scope? |
|---|------|---------|-----------|
| 1 | `GET /v1/species` | List all name usages | ✅ |
| 2 | `GET /v1/species/suggest` | Name autocomplete service | ✅ |
| 3 | `GET /v1/species/search` | Full text search over name usages | ✅ |
| 4 | `GET /v2/species/match` | Fuzzy name match service (v2) | ✅ |
| 5 | `GET /v1/species/match` | Legacy fuzzy name match (v1) | ✅ |
| 6 | `GET /v2/species/match/metadata` | Retrieve metadata about matching service | ✅ |
| 7 | `GET /v2/species/match/joins/{identifier}` | ID join lookup service | ✅ |
| 8 | `GET /v2/species/match/id/{identifier}` | ID lookup service | ✅ |
| 9 | `GET /v2/species/match/id/{datasetId}/{identifier}` | ID lookup service by dataset | ✅ |
| 10 | `GET /v1/species/{usageKey}` | Name usage by id | ✅ |
| 11 | `GET /v1/species/{usageKey}/vernacularNames` | Vernacular names by id | ✅ |
| 12 | `GET /v1/species/{usageKey}/verbatim` | Verbatim name usage by id | ✅ |
| 13 | `GET /v1/species/{usageKey}/typeSpecimens` | Type specimens by id | ✅ |
| 14 | `GET /v1/species/{usageKey}/toc` | Descriptions table of contents | ✅ |
| 15 | `GET /v1/species/{usageKey}/synonyms` | Synonyms by id | ✅ |
| 16 | `GET /v1/species/{usageKey}/speciesProfiles` | Species profiles by id | ✅ |
| 17 | `GET /v1/species/{usageKey}/related` | Related name usages by id | ✅ |
| 18 | `GET /v1/species/{usageKey}/references` | References by id | ✅ |
| 19 | `GET /v1/species/{usageKey}/parents` | Parent name usages by id | ✅ |
| 20 | `GET /v1/species/{usageKey}/name` | Parsed name usage by id | ✅ |
| 21 | `GET /v1/species/{usageKey}/metrics` | Name usage metrics by id | ✅ |
| 22 | `GET /v1/species/{usageKey}/media` | Media by id | ✅ |
| 23 | `GET /v1/species/{usageKey}/iucnRedListCategory` | IUCN Red List Category | ✅ |
| 24 | `GET /v1/species/{usageKey}/identifier` | Identifiers by id | ✅ |
| 25 | `GET /v1/species/{usageKey}/distributions` | Distributions by id | ✅ |
| 26 | `GET /v1/species/{usageKey}/descriptions` | Descriptions by id | ✅ |
| 27 | `GET /v1/species/{usageKey}/combinations` | Recombinations by id | ✅ |
| 28 | `GET /v1/species/{usageKey}/childrenAll` | All children by id (flat) | ✅ |
| 29 | `GET /v1/species/{usageKey}/children` | Children by id | ✅ |
| 30 | `GET /v1/species/root/{datasetKey}` | Root name usages of a dataset | ✅ |
| 31 | `GET /v1/parser/name` | Parse a scientific name | ✅ |

**Excluded from Species API:** `POST /v2/species/match` (batch match — mutation),
`POST /v1/parser/name` (batch parse — mutation).

### Occurrence API — GET endpoints

From `/openapi/occurrence.json` — key read-only GETs:

| # | Path | Summary | In scope? |
|---|------|---------|-----------|
| 1 | `GET /occurrence/{key}` | Single occurrence record | ✅ |
| 2 | `GET /occurrence/search` | Search occurrences (paged) | ✅ |
| 3 | `GET /occurrence/{key}/verbatim` | Verbatim occurrence record | ✅ |
| 4 | `GET /occurrence/{key}/fragment` | Raw occurrence fragment | ✅ |
| 5 | `GET /occurrence/download/{key}` | Download status/metadata | ❌ — download admin |
| 6 | `GET /occurrence/download/dataset/{key}` | Dataset download stats | ❌ — download admin |
| 7 | `GET /occurrence/download/organization/{key}` | Orgs download stats | ❌ — download admin |
| 8 | `GET /occurrence/download/statistics` | Download statistics | ❌ — download admin |
| 9 | `GET /occurrence/download/{key}/result` | Download result data | ❌ — download binary |
| 10 | `GET /occurrence/download/format/{key}` | Download format fields | ❌ — schema, not data |
| 11 | `GET /occurrence/count` | Count occurrences | ✅ |
| 12 | `GET /occurrence/{key}/image` | Occurrence image | ❌ — thumbor proxy |
| 13 | `GET /occurrence/citations` | Citations for an occurrence | ✅ |
| 14 | `GET /occurrence/distinctCount` | Distinct value counts | ✅ |
| 15 | `GET /occurrence/inventory` | Inventory (distinct values + count) | ✅ |
| 16 | `GET /occurrence/metrics` | Occurrence metrics | ✅ |

**Excluded:** All download-related endpoints (auth-gated, admin/export, not
research-reads), image proxy (not data).

### Literature API — GET endpoints

From `/openapi/literature.json`:

| # | Path | Summary | In scope? |
|---|------|---------|-----------|
| 1 | `GET /literature/{uuid}` | Single literature item | ✅ |
| 2 | `GET /literature/search` | Search literature (paged) | ✅ |
| 3 | `GET /literature/export` | Export search results | ❌ — binary TSV/CSV download |

### Maps API

From `https://techdocs.gbif.org/en/openapi/v2/maps/` — the Maps API
documentation mentions tile/marker/static-map endpoints. These are primarily
image-rendering endpoints (PNG tiles, marker overlays), not data-retrieval.
Excluded as research-reads; they're visualization tools.

## Grouping for implementation

### Group A — Species search & match (5 ops)

Identical `offset-limit` pagination with `results` itemsPath. High-value
entry points for any species query.

| Operation name | Path | `via` | Notes |
|---------------|------|-------|-------|
| `searchSpecies` | `GET /v1/species/search` | `paginate` | Full-text, `q`, `rank`, `datasetKey`, `limit`/`offset` |
| `suggestSpecies` | `GET /v1/species/suggest` | `restGet` | Autocomplete — returns array, not paged |
| `matchSpecies` | `GET /v2/species/match` | `restGet` | Fuzzy match by `kingdom`, `phylum`, `class`, `order`, `family`, `genus`, `scientificName`, `rank`, `verbose` |
| `matchSpeciesV1` | `GET /v1/species/match` | `restGet` | Legacy flat-format match |
| `lookupSpeciesId` | `GET /v2/species/match/id/{identifier}` | `restGet` | Lookup by external ID (GBIF, COL, ITIS, etc.) |
| `lookupSpeciesJoin` | `GET /v2/species/match/joins/{identifier}` | `restGet` | Join lookup |

### Group B — Species detail sub-resources (18 ops)

All share the same shape: `GET /v1/species/{usageKey}/{subresource}` returning
a sub-object or array. Single-resource lookups → `via: restGet`.

| Operation name | Path | `via` |
|---------------|------|-------|
| `getSpecies` | `GET /v1/species/{usageKey}` | `restGet` |
| `getSpeciesVernacularNames` | `GET /v1/species/{usageKey}/vernacularNames` | `restGet` |
| `getSpeciesVerbatim` | `GET /v1/species/{usageKey}/verbatim` | `restGet` |
| `getSpeciesTypeSpecimens` | `GET /v1/species/{usageKey}/typeSpecimens` | `restGet` |
| `getSpeciesToc` | `GET /v1/species/{usageKey}/toc` | `restGet` |
| `getSpeciesSynonyms` | `GET /v1/species/{usageKey}/synonyms` | `restGet` |
| `getSpeciesProfiles` | `GET /v1/species/{usageKey}/speciesProfiles` | `restGet` |
| `getSpeciesRelated` | `GET /v1/species/{usageKey}/related` | `restGet` |
| `getSpeciesReferences` | `GET /v1/species/{usageKey}/references` | `restGet` |
| `getSpeciesParents` | `GET /v1/species/{usageKey}/parents` | `restGet` |
| `getSpeciesNameParsed` | `GET /v1/species/{usageKey}/name` | `restGet` |
| `getSpeciesMetrics` | `GET /v1/species/{usageKey}/metrics` | `restGet` |
| `getSpeciesMedia` | `GET /v1/species/{usageKey}/media` | `restGet` |
| `getSpeciesIucnStatus` | `GET /v1/species/{usageKey}/iucnRedListCategory` | `restGet` |
| `getSpeciesIdentifiers` | `GET /v1/species/{usageKey}/identifier` | `restGet` |
| `getSpeciesDistributions` | `GET /v1/species/{usageKey}/distributions` | `restGet` |
| `getSpeciesDescriptions` | `GET /v1/species/{usageKey}/descriptions` | `restGet` |
| `getSpeciesCombinations` | `GET /v1/species/{usageKey}/combinations` | `restGet` |
| `getSpeciesChildren` | `GET /v1/species/{usageKey}/children` | `restGet` |
| `getSpeciesAllChildren` | `GET /v1/species/{usageKey}/childrenAll` | `restGet` |

**Note:** `getSpeciesSynonyms`, `getSpeciesChildren`, `getSpeciesMedia`,
`getSpeciesRelated`, `getSpeciesDistributions` return potentially long lists.
Their OpenAPI specs use the same `PagingResponse` wrapper (`offset`, `limit`,
`endOfRecords`, `results[]`). Switch to `via: paginate` if a live probe shows
the response actually paginates (the spec declares `endOfRecords` which
suggests these do paginate).

**Decision:** Mark these for `via: restGet` initially, document the
`endOfRecords` ceiling as a `ponytail:` comment. If the result set is
truncated in practice, upgrade to `paginate` when/if it becomes a problem.

### Group C — Root usages & parser (2 ops)

| Operation name | Path | `via` |
|---------------|------|-------|
| `getSpeciesRootUsages` | `GET /v1/species/root/{datasetKey}` | `restGet` |
| `parseSpeciesName` | `GET /v1/parser/name` | `restGet` |

### Group D — Occurrence reads (7 ops)

`offset-limit` pagination with `endOfRecords` boolean termination
(same pattern as Species). Search returns `count` for total estimate.

| Operation name | Path | `via` | Notes |
|---------------|------|-------|-------|
| `getOccurrence` | `GET /occurrence/{key}` | `restGet` | Single record by GBIF key |
| `searchOccurrences` | `GET /occurrence/search` | `paginate` | Paged, max 300/page, hard 100K offset limit |
| `getOccurrenceVerbatim` | `GET /occurrence/{key}/verbatim` | `restGet` | Raw verbatim record |
| `getOccurrenceFragment` | `GET /occurrence/{key}/fragment` | `restGet` | Raw fragment (XML) |
| `countOccurrences` | `GET /occurrence/count` | `restGet` | Aggregate count for search filters |
| `getOccurrenceMetrics` | `GET /occurrence/metrics` | `restGet` | Various counts/metrics |
| `getOccurrenceDistinctCounts` | `GET /occurrence/distinctCount` | `restGet` | Distinct value counts by property |
| `getOccurrenceInventory` | `GET /occurrence/inventory` | `restGet` | Inventory (distinct values + counts) |

### Group E — Literature (2 ops)

| Operation name | Path | `via` | Notes |
|---------------|------|-------|-------|
| `searchLiterature` | `GET /literature/search` | `paginate` | Paged, `offset-limit`, many filter params |
| `getLiterature` | `GET /literature/{uuid}` | `restGet` | Single item by UUID |

## Implementation phases

### Phase -1 — Cache specs locally

OpenAPI JSON specs already fetched and cached at:

- `spec/checklistbank.json` — Species API
- `spec/occurrence.json` — Occurrence API
- `spec/literature.json` — Literature API

### Phase 1 — Group A: Species search & match (6 ops)

Add `searchSpecies`, `suggestSpecies`, `matchSpecies`, `matchSpeciesV1`,
`lookupSpeciesId`, `lookupSpeciesJoin` to `guide.md`.

All use `via: restGet` except `searchSpecies` which uses `via: paginate`
with `style: offset-limit`, `itemsPath: results`.

### Phase 2 — Group B: Species detail sub-resources (20 ops)

Add all `getSpecies*` sub-resource operations. All `via: restGet` initially
with a `ponytail: paginate if endOfRecords truncation observed` note.

### Phase 3 — Group C: Root usages & parser (2 ops)

Add `getSpeciesRootUsages`, `parseSpeciesName`.

### Phase 4 — Group D: Occurrence reads (8 ops)

Add `getOccurrence`, `searchOccurrences`, `getOccurrenceVerbatim`,
`getOccurrenceFragment`, `countOccurrences`, `getOccurrenceMetrics`,
`getOccurrenceDistinctCounts`, `getOccurrenceInventory`.

`searchOccurrences` uses `via: paginate` with `style: offset-limit`,
`itemsPath: results`. The API enforces a hard 100,000 record ceiling
(offset + limit ≤ 100,000) — document this in the operation description.

### Phase 5 — Group E: Literature (2 ops)

Add `searchLiterature`, `getLiterature`.

### Phase 6 — Update existing `listSpecies`

The current `listSpecies` operation has `pageSize: 2` which is a test
artifact, not a production default. Update to GBIF's actual default of
`pageSize: 20` (observed from live probe: no explicit limit returns 20).

## Testing

Follow the boe.es pattern — tests are colocated in `api-guides/api.gbif.org/`.

**`endpoint-coverage.test.ts`** (`HOST_INTEGRATION=1`-gated):

- Verify `searchSpecies` returns `results` array with `endOfRecords`
- Verify `suggestSpecies` returns array of suggestions for `q=Canis`
- Verify `matchSpecies` returns `usage` with `matchType`
- Verify `getOccurrence` returns a single record for a known key
- Verify `searchOccurrences` returns paged results with `count`
- Verify `searchLiterature` returns paged results
- Verify `listSpecies` (existing) remains functional

**`helper.test.ts`** — Skipped unless a transform is added. The existing
`listSpecies` uses no helper; the new operations likewise use standard
`restGet`/`paginate`. No helper code needed.

## Files touched

| File | Action |
|------|--------|
| `guide.md` | Major expansion — add Groups A–E |
| `spec/checklistbank.json` | Add (cached OpenAPI spec) |
| `spec/occurrence.json` | Add (cached OpenAPI spec) |
| `spec/literature.json` | Add (cached OpenAPI spec) |
| `endpoint-coverage.test.ts` | Add (live coverage test) |

## Out of scope / deliberate omissions

- **Registry API** (datasets, organizations, nodes, networks): CRUD-heavy
  admin endpoints. The principal methods overview page recommends them only
  for advanced users. A research aide doesn't need to create/edit datasets.
  If a user needs to look up a dataset by UUID, that's a single `restGet`
  that can be added in a future pass.
- **Occurrence Image API**: Thumbor image proxy, not data retrieval.
- **Maps API**: Tile rendering (PNG), not structured data. The tile queries
  (`/v2/maps/occurrence/{taxonKey}/tile?x=&y=&z=`) return image tiles.
- **Vocabulary API**: Enumeration/lookup tables for GBIF internal use.
  Low value for a research aide; concepts can be browsed via the web portal.
- **Validator API**: POST-heavy (validate/upload datasets), not read-only.
- **Analytics & Data Trends**: No documented machine-readable GET endpoints.
- **POST endpoints**: `POST /v2/species/match` (batch match),
  `POST /v1/parser/name` (batch parse) — mutation.
- **Download endpoints**: Auth-gated download request/submit/result.
- **`pageSize: 2` → `pageSize: 20`**: Fixing the existing test-artifact
  page size as part of the expansion.

## Implementation notes (2026-08-06)

**Shipped: 36 ops** (1 existing `listSpecies` + 35 new). Live gate green
(`HOST_INTEGRATION=1`, 37/37); bare CI green. Deviations from the frozen plan:

1. **Occurrence + Literature paths need a `/v1/` version prefix.** The plan's
   tables wrote `/occurrence/…` and `/literature/…`, but live probes 404 on
   those; the apps mount under `/v1/occurrence/…` and `/v1/literature/…`
   (Species already used `/v1`; the `match` endpoints use `/v2`). Fixed in
   `guide.md`.
2. **Dropped 3 planned occurrence ops** — `getOccurrenceMetrics`,
   `getOccurrenceDistinctCounts`, `getOccurrenceInventory`. The audit's
   Occurrence table listed them, but they are **not** in the occurrence OpenAPI
   spec (`occurrence.json` documents only `/occurrence/count` and
   `/occurrence/search`) and all three return **HTTP 400** live across every
   parameter combination probed. They are not real endpoints → removed. Group D
   ships 5 ops, not 8.
3. **`getSpeciesVerbatim` needs a source-dataset usage key.** The backbone
   `Canis lupus` nubKey `5219173` has no verbatim record (404). Tests use a
   source key (`206095529`) that has a verbatim row. (Real behavior, not a data
   bug — verbatim exists only for source records.)
4. **`lookupSpeciesId` (`/v2/species/match/id/{identifier}`) returns `[]`** for
   every identifier probed (backbone keys, WoRMS AphiaID, `worms:` and full
   LSID forms). Endpoint is documented and returns 200, but matches only
   backbone-indexed external IDs. Kept with a shape assertion
   (`Array.isArray`); `lookupSpeciesJoin` (same identifiers) returns non-empty
   and asserts non-empty.
5. **Group B sub-resources shipped `restGet`** as the plan decided, with a
   `ponytail:` note in the recipe frontmatter to upgrade the `endOfRecords`
   list-shaped ones to `paginate` if truncation is observed. `verbatim`
   needs a source key (see #3); `typeSpecimens`/`identifier`/`combinations`
   legitimately return empty arrays for the wolf — assertions check shape.
6. **`listSpecies` pageSize 2 → 20** (Phase 6) — done.

No WAF quirks (GBIF is not WAF'd), no `spec/` contents committed (spec files
predate this rollout and stay as local dev cache).

**C2 note (2026-08-06, final re-run):** the live gate passed **37/37** in the
initial run. On the subsequent review re-run, `searchOccurrences` failed with
**HTTP 503 "Backend fetch failed"** (Varnish) that persisted across all
queries (attempted with retry+backoff in `fetchOp`); direct probes confirmed
`/v1/occurrence/search` was 503-degraded for **every** search query while
`/occurrence/count` and `/occurrence/{key}` stayed 200 — an upstream
occurrence-search backend outage, not a recipe defect. Bare CI (the binding
gate) is unaffected. The op already passed live once with the correct
`results` shape; it will self-heal when GBIF's search backend recovers.
