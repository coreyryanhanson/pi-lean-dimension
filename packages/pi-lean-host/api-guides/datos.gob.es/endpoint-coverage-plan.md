# datos.gob.es API — Endpoint Coverage Plan

> Drafted 2026-07-20 against the live accessible docs page
> <https://datos.gob.es/en/accessible-apidata> (verified by `web-fetch`
> on 2026-07-20 — the Swagger page at `/en/apidata` loads its spec from
> a JS-rendered `/swagger/api.json`; the accessible version at
> `/en/accessible-apidata` is server-rendered HTML with the complete
> endpoint table). Implements the 21 read-only endpoints the current
> `guide.md` does not yet cover.

## Status quo

`guide.md` declares **1 of 22** documented read-only endpoints:

| Implemented | Operation | Path |
|-------------|-----------|------|
| ✅ | `listDatasets` | `/apidata/catalog/dataset` |

## WAF / Firewall note

During plan drafting, live-probe `curl` requests to the API endpoints
(e.g. `/apidata/catalog/publisher`, `/apidata/nti/public-sector`)
returned **HTTP 503** with Imperva/Incapsula WAF headers
(`x-cdn: Imperva`, `x-iinfo` fingerprinting). The WAF blocks raw
`curl` / non-browser User-Agents.

However, the existing `listDatasets` operation works through the
pi-lean-host `restGet`/`paginate` tool — it uses Node.js `fetch()`
with standard headers and presumably a browser-like UA. This means
live probes (Phase 0) and integration tests
(`endpoint-coverage.test.ts`) may need to run through the same
HTTP client rather than raw `curl`.

See [`WAF-NOTES.md`](../WAF-NOTES.md) for the central tracker.

## Verification (2026-07-20)

Fetched the accessible docs page by `web-fetch` (the HTML page itself
is not WAF-blocked — only the API endpoints are). The authoritative
endpoint list, organised by the docs' own sections, is below.

The API is a CKAN-style Linked-Data-API (LDA). All list endpoints share
the same envelope shape (`result.items`, `result.next`/`result.first`
for pagination) and accept the same query params (`_pageSize` max 50,
`_page` 0-based, `_sort`). No auth required.

### Data Catalogue — Datasets (9 endpoints)

| # | Method | Path | Description | In guide? |
|---|--------|------|-------------|-----------|
| 1 | GET | `/apidata/catalog/dataset` | All datasets (paginated) | ✅ `listDatasets` |
| 2 | GET | `/apidata/catalog/dataset/{id}` | Dataset by ID (single item) | ❌ |
| 3 | GET | `/apidata/catalog/dataset/title/{title}` | Datasets by title substring | ❌ |
| 4 | GET | `/apidata/catalog/dataset/publisher/{id}` | Datasets by publisher ID | ❌ |
| 5 | GET | `/apidata/catalog/dataset/theme/{id}` | Datasets by theme/category | ❌ |
| 6 | GET | `/apidata/catalog/dataset/format/{format}` | Datasets by distribution format (CSV, JSON, XML, etc.) | ❌ |
| 7 | GET | `/apidata/catalog/dataset/keyword/{keyword}` | Datasets by tag/keyword | ❌ |
| 8 | GET | `/apidata/catalog/dataset/spatial/{spatialWord1}/{spatialWord2}` | Datasets by geographic scope | ❌ |
| 9 | GET | `/apidata/catalog/dataset/modified/begin/{beginDate}/end/{endDate}` | Datasets modified between ISO dates | ❌ |

### Data Catalogue — Distributions (3 endpoints)

| # | Method | Path | Description | In guide? |
|---|--------|------|-------------|-----------|
| 10 | GET | `/apidata/catalog/distribution` | All distributions (paginated) | ❌ |
| 11 | GET | `/apidata/catalog/distribution/dataset/{id}` | Distributions of a dataset | ❌ |
| 12 | GET | `/apidata/catalog/distribution/format/{format}` | Distributions in a specific format | ❌ |

### Data Catalogue — Lookup tables (3 endpoints)

| # | Method | Path | Description | In guide? |
|---|--------|------|-------------|-----------|
| 13 | GET | `/apidata/catalog/publisher` | All publishers | ❌ |
| 14 | GET | `/apidata/catalog/spatial` | All geographical scopes | ❌ |
| 15 | GET | `/apidata/catalog/theme` | All categories/themes | ❌ |

### NTI — Public Sector Taxonomy (2 endpoints)

Annex IV of the Spanish NTI (Technical Interoperability Regulation).

| # | Method | Path | Description | In guide? |
|---|--------|------|-------------|-----------|
| 16 | GET | `/apidata/nti/public-sector` | All primary sectors (taxonomy list) | ❌ |
| 17 | GET | `/apidata/nti/public-sector/{id}` | Specific sector by ID | ❌ |

### NTI — Territory (5 endpoints)

Annex V of the Spanish NTI.

| # | Method | Path | Description | In guide? |
|---|--------|------|-------------|-----------|
| 18 | GET | `/apidata/nti/territory/Province` | All provinces | ❌ |
| 19 | GET | `/apidata/nti/territory/Province/{id}` | Specific province by ID | ❌ |
| 20 | GET | `/apidata/nti/territory/Autonomous-region` | All autonomous regions | ❌ |
| 21 | GET | `/apidata/nti/territory/Autonomous-region/{id}` | Specific autonomous region by ID | ❌ |
| 22 | GET | `/apidata/nti/territory/Country/España` | Country (Spain) | ❌ |

→ **21 endpoints to add.** All are read-only GETs. No auth. No mutation.

**Out-of-scope rows (dropped with reason):**

- **SPARQL endpoint** (`/en/sparql`): A SPARQL protocol query interface,
  not a REST API. A SPARQL client is a different tool; the guide's
  `restGet`/`paginate` mechanism does not translate SPARQL queries.
  Out of scope for this guide expansion.
- **Create/update/delete dataset operations**: These exist in the CKAN
  backend but require auth and mutate state. The accessible docs page
  only documents read operations; the CKAN Action API writes are not
  listed. Not documented, not in scope.
- **Swagger UI `/swagger/api.json`**: This is the machine-readable spec
  file, not an endpoint. It exists to drive the interactive Swagger UI.

## Grouping for implementation

### Group A — Dataset search/lookup endpoints (7 ops, shared prefix)

All under `/apidata/catalog/dataset/`. All return the same LDA envelope
shape. Unlike `listDatasets` which is a flat-list browse, these are
filtered searches — the path segment after `/dataset/` is the filter
criterion. All paginate the same way as `listDatasets` (nextLink).

| Operation (proposed) | Path suffix | `via` |
|----------------------|-------------|-------|
| `getDatasetById` | `/{id}` | `restGet` (single item) |
| `searchDatasetsByTitle` | `/title/{title}` | `paginate` |
| `searchDatasetsByPublisher` | `/publisher/{id}` | `paginate` |
| `searchDatasetsByTheme` | `/theme/{id}` | `paginate` |
| `searchDatasetsByFormat` | `/format/{format}` | `paginate` |
| `searchDatasetsByKeyword` | `/keyword/{keyword}` | `paginate` |
| `searchDatasetsBySpatial` | `/spatial/{spatialWord1}/{spatialWord2}` | `paginate` |
| `searchDatasetsModifiedBetween` | `/modified/begin/{beginDate}/end/{endDate}` | `paginate` |

- `getDatasetById` is `via: restGet` (single-resource lookup, no
  pagination needed).
- The 7 search endpoints share the existing `paginate` config with
  `style: nextLink`, `itemsPath: result.items`,
  `nextLinkPath: result.next`. Same `_pageSize`, `_page`, `_sort`
  params.
- **No helper needed** for any of these — path params are simple slugs
  or ISO dates. The date params in `modified/begin/{begin}/end/{end}`
  are ISO 8601 (already the native format), no date transform needed.

### Group B — Distribution endpoints (3 ops, shared prefix)

All under `/apidata/catalog/distribution/`.

| Operation (proposed) | Path suffix | `via` |
|----------------------|-------------|-------|
| `listDistributions` | (none — `/distributions`) | `paginate` |
| `searchDistributionsByDataset` | `/dataset/{id}` | `paginate` |
| `searchDistributionsByFormat` | `/format/{format}` | `paginate` |

- Same LDA envelope, same pagination config. `accept: json`.

### Group C — Lookup tables (3 ops, trivial)

| Operation (proposed) | Path | `via` |
|----------------------|------|-------|
| `listPublishers` | `/apidata/catalog/publisher` | `paginate` |
| `listSpatial` | `/apidata/catalog/spatial` | `paginate` |
| `listThemes` | `/apidata/catalog/theme` | `paginate` |

- These return the LDA envelope (paginated, with `result.items` and
  `result.next`). They're trivial list endpoints — no params beyond the
  standard `_pageSize`/`_page`.
- **Pagination probe note:** These are documented as simple GETs with
  no explicit `_pageSize` hint in the accessible docs, but they share
  the same LDA infrastructure as `listDatasets`. The plan assumes
  `paginate` with the same nextLink config; if a live probe (Phase 0)
  shows they return a flat list with no `result.next`, downgrade to
  `restGet`.

### Group D — NTI Public Sector (2 ops)

| Operation (proposed) | Path | `via` |
|----------------------|------|-------|
| `listPublicSectors` | `/apidata/nti/public-sector` | `restGet` (taxonomy — likely flat list) |
| `getPublicSectorById` | `/apidata/nti/public-sector/{id}` | `restGet` |

- The NTI taxonomy endpoints are small vocabularies, not large
  catalogue lists. The docs don't show pagination params for these.
  `restGet` is appropriate.

### Group E — NTI Territory (5 ops)

| Operation (proposed) | Path | `via` |
|----------------------|------|-------|
| `listProvinces` | `/apidata/nti/territory/Province` | `restGet` |
| `getProvinceById` | `/apidata/nti/territory/Province/{id}` | `restGet` |
| `listAutonomousRegions` | `/apidata/nti/territory/Autonomous-region` | `restGet` |
| `getAutonomousRegionById` | `/apidata/nti/territory/Autonomous-region/{id}` | `restGet` |
| `getCountrySpain` | `/apidata/nti/territory/Country/España` | `restGet` |

- Same reasoning as Group D — small controlled vocabularies, `restGet`.

## Implementation phases

### Phase -1 — Cache specs locally (skip)

The accessible docs page is a single HTML page (fetched above). No
PDFs or multi-page specs to cache. Skip.

### Phase 0 — Live shape probes (2 probes)

1. **Probe lookup table pagination:** call
   `/apidata/catalog/publisher?_pageSize=2` and check whether the
   response has `result.next` and follows the same LDA envelope as
   `listDatasets`. If yes, Groups C endpoints use `paginate`; if the
   response is a flat list with no nextLink, downgrade to `restGet`.
2. **Probe NTI taxonomy response shape:** call
   `/apidata/nti/public-sector` and verify the response structure (plain
   JSON array vs LDA envelope). Confirms `restGet` is correct for
   Groups D and E.

### Phase 1 — Add Group A (dataset search/lookup)

Add 7 missing dataset-filter operations and 1 single-item lookup to
`guide.md`. These are the highest-value additions — a research agent
can search by title, publisher, theme, keyword, format, geography, or
modification date.

### Phase 2 — Add Group B (distribution endpoints)

Add 3 distribution operations. Moderate value — useful for finding
download URLs and file formats.

### Phase 3 — Add Group C (lookup tables)

Add 3 publisher/spatial/theme list operations. Low value individually
but they complete the catalogue browsing surface.

### Phase 4 — Add Groups D+E (NTI taxonomy)

Add 7 NTI operations (public sector + territory). These are controlled
vocabularies — useful for mapping coded fields in dataset results but
not the primary search path.

## Testing

Follow the boe.es pattern — one co-located test file:

1. **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated:
   Parses the recipe, executes every defined operation, asserts:
   - Groups A search endpoints: status 200, body has `result.items`
     array.
   - `getDatasetById`: status 200, body has `result.items` (LDA
     envelope with one item).
   - Groups B+C: status 200, same LDA envelope shape.
   - Groups D+E: status 200, returns non-empty items.
   - One assertion per operation.

2. **`helper.test.ts`** — Not needed. No helper transforms are
   proposed. The existing `helper.ts` is not touched.

Manual: run `api-guide datos.gob.es` from a pi session, confirm all
~22 ops appear with correct param hints.

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 7 dataset search ops (Phase 1) + 3 distribution ops (Phase 2) + 3 lookup-table ops (Phase 3) + 7 NTI taxonomy ops (Phase 4) |
| `helper.ts` | Unchanged (no transforms needed) |
| `endpoint-coverage.test.ts` | Create with live coverage for every op |
| `helper.test.ts` | Unchanged (not created) |
| `spec/` | Not created (single HTML page, no PDFs) |

## Out of scope / deliberate omissions

- **SPARQL query endpoint:** The site also advertises a SPARQL endpoint
  at `/en/sparql`. SPARQL is a query language, not a REST API — it
  requires `query` POST parameters and returns SPARQL result XML/JSON,
  not the LDA envelope. Out of scope for `guide.md` operations.
- **CKAN Action API writes:** The underlying CKAN platform has
  `package_create`, `package_update`, `resource_create`, etc. These
  require API key auth and mutate state. Not documented on the API
  docs page. Out of scope.
- **Format-variant suffixes (`.json`, `.xml`, `.rdf`, `.ttl`, `.csv`):**
  The API supports format extensions on any endpoint (documented on
  the accessible page). The LDA envelope is the same; only
  serialization changes. Use `accept: json` consistently; adding a
  format-variant operation for each endpoint would multiply ops
  without adding research value. If a specific use case needs RDF/XML,
  pass the `Accept` header or `.xml` suffix manually.

---

## Implementation notes (2026-08-05)

Implemented all 21 planned ops (`guide.md` now 22 ops). Verification: live
via `HOST_INTEGRATION=1` — 21/22 pass; bare CI 22 skip; `all-guides-parse`
16/16 green; `axis-units` 4/4 green.

### Deviations from the frozen plan (all from Phase 0 probes)

1. **`getPublicSectorById` path changed.** The plan (from the accessible
   docs) wrote `/apidata/nti/public-sector/{id}`. Live probes return **404**
   for every `{id}` — including the docs' own example `comercio`. The working
   form is `/apidata/nti/public-sector/sector/{id}` (needs the mid-path
   `sector/` segment). Recipe updated accordingly.
2. **Group D + E list endpoints use `paginate`, not `restGet`.** The plan
   assumed `listPublicSectors`, `listProvinces`, `listAutonomousRegions` are
   flat taxonomies (`restGet`). Phase 0 probes show they return the standard
   LDA envelope **with `result.next`** (paginated), so they are `paginate`
   (nextLink), matching the other list ops. The plan's own Phase 0 probe #2
   flagged this exact contingency ("if the response is a flat list with no
   nextLink, downgrade to restGet" — the opposite happened). The single-item
   lookups (`getPublicSectorById`, `getProvinceById`, `getAutonomousRegionById`,
   `getCountrySpain`) remain `restGet`.
3. **`format` is a plain token, not a MIME type.** Plan prose lists format
   values as "CSV, JSON, XML". A `text/csv` probe returns HTTP 400; `csv`
   works. Param doc updated to say "plain token".
4. **Syntax validated by `all-guides-parse`.** The repository validator rejects
   re-declaring a path param (`{token}`) in the op's `params` map. Initial
   draft declared e.g. `id:`/`title:`/`format:` in `params`; removed — path
   params are inferred from the path.
5. **`listSpatial` fails live (`HTTP 500`), server-side data bug — not a WAF block and not a query-structuring issue.** The endpoint `/apidata/catalog/spatial` consistently returns `{E211} Base URI is null, but there are relative URIs to resolve: <miteco-hvd>` — an LDA serializer failure on a single corrupt vocabulary item (`<miteco-hvd>`, a MITECO high-value-dataset spatial scope whose RDF carries a relative URI with no base). Diagnostics (2026-08-05): **every** format suffix (`.json`, `.xml`, `.rdf`, `.ttl`, `.csv`) and Accept variant 500s on page 0; the same requests to `?_page=1` return 200 in both JSON and RDF, and page-1 items are clean (`idee.es/bnode/N…`). So the failure is data-specific (page 0 always includes the broken item), not format- or param-induced. A client-side workaround (seeding `_page: 1`) would silently skip items 0–9, which is worse than an honest failure. Kept in the guide (documented endpoint, per plan's "documented deviation" path). The live `endpoint-coverage` assertion is expected to fail until the portal fixes the `<miteco-hvd>` entry; this is the C2 escaped case (record failure, still ship, bare CI is the binding gate).

### Direct probes used

Phase 0 probes ran through the pi-lean-host `restGet`/`paginate` path (the
WAF-safe route) using the docs-page example values from
`/en/accessible-apidata` (`Autonomia/Pais-Vasco`, `hacienda`, `empleo`,
`salud`, `csv`, `E05068001`, ISO date window).
Micro searches confirmed:

- every Group A/B/C/D/E list returns `result` + `result.next` (paginate).
- dataset search by title/publisher/theme/format/keyword/spatial/modified all
  return items.
- derived dataset id (from `listDatasets` first item's `_about`) feeds
  `getDatasetById` and `searchDistributionsByDataset` in-test.
