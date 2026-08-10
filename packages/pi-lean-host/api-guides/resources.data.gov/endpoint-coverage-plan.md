# Data.gov Catalog API — Endpoint Coverage Plan

> Drafted 2026-07-20 against the live docs page
> <https://resources.data.gov/catalog-api/> (verified by `web-fetch` on
> 2026-07-20). Implements the 7 read-only endpoints the current
> `guide.md` does not yet cover.

## Status quo

`guide.md` declares **1 of 8** documented read-only endpoints:

| Implemented | Operation | Path |
|-------------|-----------|------|
| ✅ | `searchDatasets` | `/technology/datagov/v4/search` |

## Verification (2026-07-20)

Fetched the full docs page by `web-fetch`. The page is server-rendered
HTML (USWDS design) with all endpoints documented in a single page
with detailed response examples. No JS rendering needed.

The API lives at `https://api.gsa.gov/technology/datagov/v4/` and
requires `X-Api-Key` header (same as the existing `searchDatasets`
operation). `DEMO_KEY` works for exploration.

### Authoritative endpoint list

| # | Method | Full path | Description | Pagination | In guide? |
|---|--------|-----------|-------------|------------|-----------|
| 1 | GET | `/technology/datagov/v4/search` | Search datasets by keyword, org, keyword, spatial filter, etc. | ✅ cursor (after param) | ✅ `searchDatasets` |
| 2 | GET | `/technology/datagov/v4/keywords` | List most-used keywords with dataset counts | ❌ flat (size param, max 1000) | ❌ |
| 3 | GET | `/technology/datagov/v4/locations/search` | Autocomplete search for geographic locations | ❌ flat (size param) | ❌ |
| 4 | GET | `/technology/datagov/v4/location/{location_id}` | Get GeoJSON geometry for a location by UUID | ❌ single-resource lookup | ❌ |
| 5 | GET | `/technology/datagov/v4/organizations` | List all publishing organizations | ❌ flat (all orgs, ~312) | ❌ |
| 6 | GET | `/technology/datagov/v4/harvest_record/{record_id}` | Get harvest record metadata by UUID | ❌ single-resource lookup | ❌ |
| 7 | GET | `/technology/datagov/v4/harvest_record/{record_id}/raw` | Get original source payload of a harvest record | ❌ single-resource lookup | ❌ |
| 8 | GET | `/technology/datagov/v4/harvest_record/{record_id}/transformed` | Get DCAT-US transformed payload of a harvest record | ❌ single-resource lookup | ❌ |

→ **7 endpoints to add.** All are read-only GETs. All require the same
`X-Api-Key` header (already configured in `guide.md` auth section).

**Out-of-scope rows (dropped with reason):** none — every documented
endpoint is a read-only GET.

## Grouping for implementation

### Group A — Dataset metadata lookups (3 ops)

The most useful additions for a research agent — lookup tables that
power the catalog search:

| Operation (proposed) | Path | `via` | Notes |
|----------------------|------|-------|-------|
| `getKeywords` | `/technology/datagov/v4/keywords` | `restGet` | `size` (1-1000, default 100) and `min_count` (default 1) query params |
| `getOrganizations` | `/technology/datagov/v4/organizations` | `restGet` | Flat list, no params. Returns ~300 orgs with slug, type, dataset count. |
| `searchLocations` | `/technology/datagov/v4/locations/search` | `restGet` | `q` (partial name) and `size` query params. Autocomplete-style. |

All three return `restGet` JSON responses (no pagination — the docs
don't mention any `after`/`page` params for these endpoints).

### Group B — Location geometry (1 op)

| Operation (proposed) | Path | `via` | Notes |
|----------------------|------|-------|-------|
| `getLocationGeometry` | `/technology/datagov/v4/location/{location_id}` | `restGet` | Path param `{location_id}` (UUID). Returns GeoJSON Polygon geometry. |

The `location_id` comes from `searchLocations` results. Single-resource
lookup.

### Group C — Harvest record inspection (3 ops)

These are niche but complete the API surface. They return operational
metadata about how datasets were ingested:

| Operation (proposed) | Path | `via` | Notes |
|----------------------|------|-------|-------|
| `getHarvestRecord` | `/technology/datagov/v4/harvest_record/{record_id}` | `restGet` | Path param `{record_id}` (UUID). Status, dates, source info. |
| `getHarvestRecordRaw` | `/technology/datagov/v4/harvest_record/{record_id}/raw` | `restGet` | Path param `{record_id}`. Dynamic Content-Type (JSON/XML/text). |
| `getHarvestRecordTransformed` | `/technology/datagov/v4/harvest_record/{record_id}/transformed` | `restGet` | Path param `{record_id}`. Always JSON (DCAT-US). |

- **No helper needed** for any group — path params are UUIDs and simple
  query params. `helper: false` (omitted).
- **No pagination** — none of these endpoints paginate.

## Implementation phases

### Phase -1 — Cache specs locally (skip)

The docs page is a single HTML page (fetched above). No PDFs or
multi-page specs. Skip.

### Phase 0 — Live shape probes (skip)

All 7 new endpoints are simple `restGet` operations with well-documented
response shapes and no pagination. The docs include full response
examples for every endpoint. No probes needed.

### Phase 1 — Add Group A (dataset metadata: keywords, orgs, locations)

Add `getKeywords`, `getOrganizations`, `searchLocations` to `guide.md`.
These are the highest-value additions — a research agent needs
organization slugs and keyword lists to effectively use the `search`
catalog.

### Phase 2 — Add Group B (location geometry)

Add `getLocationGeometry`. Useful for spatial-aware agents that want to
convert location names to GeoJSON for spatial filtering in search.

### Phase 3 — Add Group C (harvest record inspection)

Add `getHarvestRecord`, `getHarvestRecordRaw`,
`getHarvestRecordTransformed`. Lower value — these are operational
metadata for dataset provenance — but complete the API surface.

## Testing

Follow the boe.es pattern — one co-located test file:

1. **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated:
   Parses the recipe, executes every defined operation, asserts:
   - `getKeywords`: status 200, body has `keywords` array.
   - `getOrganizations`: status 200, body has `organizations` array.
   - `searchLocations`: status 200 with `q=Colorado`, body has
     `locations` array.
   - `getLocationGeometry`: status 404 expected (will use a
     fake UUID — no live UUID available without a prior search),
     just assert the endpoint resolves. Or skip this one.
   - Harvest record ops: similar 404-expected assertion with a
     fake UUID. The point is confirming the endpoint is reachable
     and returns the right error shape.
   - One assertion per operation.

2. **`helper.test.ts`** — Not needed. No helper transforms are
   proposed. `helper.ts` is not touched.

Manual: run `api-guide resources.data.gov` from a pi session, confirm
all 8 ops appear with correct param hints.

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 3 metadata lookups (Phase 1) + 1 location geometry op (Phase 2) + 3 harvest record ops (Phase 3) |
| `helper.ts` | Unchanged (no transforms needed) |
| `endpoint-coverage.test.ts` | Create with live coverage for every op |
| `helper.test.ts` | Unchanged (not created) |
| `spec/` | Not created (single HTML page) |

## Out of scope / deliberate omissions

- **API key registration endpoint:** The docs point to
  <https://api.data.gov/signup> for key registration. That's a human
  web form, not an API endpoint. Out of scope.
- **api.data.gov rate-limit check:** The docs mention
  `X-RateLimit-Remaining` headers and a `429` error response, but
  there's no documented endpoint to query current rate limit status.
  Not an API operation.
- **Harvest job endpoints:** The docs only document harvest record
  lookups. Harvest job endpoints (listing jobs, triggering harvests)
  are not documented. If they exist, they'd likely be write/mutation
  operations. Out of scope.

## Implementation notes (2026-08-06)

Implemented 2026-08-06. All 7 planned ops shipped; `guide.md` now has 8
ops. All deviations below are testing-strategy adjustments within the
plan's own Testing section, not endpoint changes.

1. **`getLocationGeometry` asserts 200, not 404.** The plan's Testing
   section expected a 404-shape assertion with a fake UUID ("no live
   UUID available without a prior search"). A live probe showed
   `locations/search` returns **numeric** ids (e.g. `"6"` for Colorado)
   and `GET /location/{id}` answers 200 for them with
   `{geometry: "<JSON-encoded GeoJSON string>", id}` — the `geometry`
   field is a JSON-encoded **string**, not an inline object. The test
   therefore derives the id from `searchLocations` in-test and asserts
   200 + geometry-string shape (stronger than the plan's 404 check).
   Docs call `location_id` a UUID, but numeric ids work; the op takes
   whatever `searchLocations` emits.
2. **Harvest ops assert the documented 404 error shape with a
   deterministic fake UUID** (`00000000-…`), as the plan's Testing
   section specifies. A live probe confirmed that even the real
   `harvest_record` UUIDs embedded in `searchDatasets` results 404 on
   `/harvest_record/{uuid}` — no 200-producing record UUID is derivable
   from the API surface. The 404 assertion (via the helper's
   `Unexpected HTTP 404` error) still proves reachability + auth
   acceptance (a bad key would 401/403) + error contract.
3. **DEMO_KEY rate limit is 10 requests per window — effectively daily.**
   Live gateway headers report `x-ratelimit-limit: 10`; the initial probe
   batch (9 requests) exhausted the bucket and it did **not** refill across
   2+ hours of 5-minute polling, so the window is closer to 23h than hourly
   (the plan's Out-of-scope note understated this). Live shape verification
   was done via direct probes (see notes 1–2) — every load the live
   assertions check: `keywords[]`, `organizations[].slug`, `locations[].id`,
   the JSON-string `geometry`, and the deterministic `Unexpected HTTP 404`
   error shape for all three harvest ops.
3b. **Registered-key override — verified.** The live suite runs with a real
   api.data.gov key (1,000 req/hr) without touching the framework or the
   shipped recipe: set `DATA_GOV_API_KEY` in the environment and `fetchOp`
   in `endpoint-coverage.test.ts` overlays it onto the parsed guide's
   `auth.headers` at runtime (post-parse mutation — `restGet` reads
   `guide.auth.headers` per call, reusing the existing header seam).
   `guide.md` keeps `DEMO_KEY` as the documented placeholder. Ran
   **2026-08-06 with a registered key: 8/8 live tests pass** (C2 green),
   including the first live exercise of guide-level `auth.headers`
   injection through `restGet` in the repo.

   **Key guard:** the 7 network ops are gated on `HOST_INTEGRATION=1`
   **and** `DATA_GOV_API_KEY` being set (`itWhenLive`); the offline parse
   smoke runs on `HOST_INTEGRATION` alone. A keyless live run therefore
   skips cleanly instead of failing on the DEMO_KEY rate wall — and GitHub
   Actions (`npm run test:ci`, never sets `HOST_INTEGRATION`) skips
   everything, so no CI secret is needed for this guide.

   ```
   DATA_GOV_API_KEY=<registered-key> HOST_INTEGRATION=1 npx vitest run packages/pi-lean-host/api-guides/resources.data.gov/
   ```

4. **`getHarvestRecordRaw` content-type gotcha.** The `/raw` endpoint
   serves the original source payload, which can be JSON/XML/text
   (dynamic). The recipe parser branches on the guide's
   `responseShape.format` (json), so a 200 XML raw payload would fail
   JSON parsing. Unobservable via the 404 tests; noted for future use
   if a live record UUID ever becomes reachable.
