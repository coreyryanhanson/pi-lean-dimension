# USGS Earthquake API — Endpoint Coverage Plan

> Drafted 2026-07-20 against the live docs pages:
>
> - GeoJSON Summary feeds: <https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php>
> - GeoJSON Detail feed: <https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson_detail.php>
> - FDSNws Event Catalog: <https://earthquake.usgs.gov/fdsnws/event/1/>
>
> Verified by `web-fetch` on 2026-07-20. Covers the read-only endpoints
> the current `guide.md` does not yet include.

## Status quo

`guide.md` declares **1 of ~28** documented read-only endpoints:

| Implemented | Operation | Path |
|-------------|-----------|------|
| ✅ | `getAllHour` | `/earthquakes/feed/v1.0/summary/all_hour.geojson` |

## Verification (2026-07-20)

Fetched all three docs pages by `web-fetch`. The authoritative endpoint
lists are below.

### A. GeoJSON Summary Feeds — 20 endpoints

The sidebar on the GeoJSON Summary page lists **20 feed URLs**, all
identical shape (GeoJSON `FeatureCollection`, no auth, no pagination):

| # | Path suffix (`/earthquakes/feed/v1.0/summary/…`) | In guide? |
|---|--------------------------------------------------|-----------|
| 1 | `all_hour.geojson` | ✅ `getAllHour` |
| 2 | `significant_hour.geojson` | ❌ |
| 3 | `4.5_hour.geojson` | ❌ |
| 4 | `2.5_hour.geojson` | ❌ |
| 5 | `1.0_hour.geojson` | ❌ |
| 6 | `all_day.geojson` | ❌ |
| 7 | `significant_day.geojson` | ❌ |
| 8 | `4.5_day.geojson` | ❌ |
| 9 | `2.5_day.geojson` | ❌ |
| 10 | `1.0_day.geojson` | ❌ |
| 11 | `all_week.geojson` | ❌ |
| 12 | `significant_week.geojson` | ❌ |
| 13 | `4.5_week.geojson` | ❌ |
| 14 | `2.5_week.geojson` | ❌ |
| 15 | `1.0_week.geojson` | ❌ |
| 16 | `all_month.geojson` | ❌ |
| 17 | `significant_month.geojson` | ❌ |
| 18 | `4.5_month.geojson` | ❌ |
| 19 | `2.5_month.geojson` | ❌ |
| 20 | `1.0_month.geojson` | ❌ |

### B. GeoJSON Detail — 1 URL pattern

Each feature in the summary feeds carries a `detail` URL:
`/earthquakes/feed/v1.0/detail/{eventId}.geojson`

Returns a single GeoJSON `Feature` with the same properties as a
summary feature plus a `products` array with all contributor data
(origin, magnitude, moment-tensor, focal-mechanism, shakemap, dyfi,
losspager, etc.).

Read-only GET, no auth, no pagination. The `{eventId}` is the event
identifier (e.g. `ci37418911`).

**Not yet in guide.** ❌

### C. FDSN Event API — 7 methods at `/fdsnws/event/1/`

| Method | Path | Description | In guide? |
|--------|------|-------------|-----------|
| `query` | `/fdsnws/event/1/query?format=geojson&…` | Search events by time, location, magnitude, catalog. Rich param set (30+ filters). Returns GeoJSON FeatureCollection. | ❌ |
| `count` | `/fdsnws/event/1/count?format=geojson&…` | Count of events matching query. Read-only. | ❌ |
| `catalogs` | `/fdsnws/event/1/catalogs` | List available catalogs. Read-only, metadata. | ❌ |
| `contributors` | `/fdsnws/event/1/contributors` | List available contributors. Read-only, metadata. | ❌ |
| `application.json` | `/fdsnws/event/1/application.json` | Enumerated parameter values for the interface. Read-only, metadata. | ❌ |
| `application.wadl` | `/fdsnws/event/1/application.wadl` | WADL API description. Read-only, metadata. | ❌ |
| `version` | `/fdsnws/event/1/version` | Service version string. Read-only, metadata. | ❌ |

**Out-of-scope rows:** none — all 7 methods are read-only GETs. The
`query` method is the high-value one; `catalogs`, `contributors`,
`application.json`, `application.wadl`, and `version` are low-value
metadata but trivially small additions (each is a one-line YAML entry).

## Grouping for implementation

### Group A — GeoJSON Summary Feeds (19 to add, identical shape)

All 19 missing feeds follow the exact same contract as the existing
`getAllHour`:

- `via: restGet` (no pagination — feeds are snapshots, not paginated)
- `accept: json`
- No auth
- No params
- Response shape: `itemsPath: features` (GeoJSON `FeatureCollection`)

Add **one operation entry per feed** per the "distinct `name`" rule.
Proposed naming: `get{Significance}{Timeframe}` e.g. `getSignificantHour`,
`getAllDay`, `get4_5Week`, etc. (Note: `4.5` → `4_5` in identifiers.)

This is a mechanical 19-op expansion. The YAML is repetitive but the
boe.es precedent (17 ops) is comparable. A pi model listing all 20
operations in context shows the agent the full feed surface.

### Group B — GeoJSON Detail (1 endpoint)

```
GET /earthquakes/feed/v1.0/detail/{eventId}.geojson
```

- `via: restGet` (single-resource lookup, no pagination)
- `accept: json`
- One path param `{eventId}`
- Response shape: a single `Feature` (not a `FeatureCollection`), so
  no `itemsPath`; the response IS the item.
- Proposed name: `getDetail`
- The `detail` URL is obtained from a feature's `properties.detail`
  field in any summary feed — the typical usage is to take an event ID
  from a feed result and look up its details.
- **No helper needed** (no date/DSL transform). `helper: false`.

### Group C — FDSN Query (1 endpoint, paginated)

```
GET /fdsnws/event/1/query
```

- `via: paginate`, `style: offset-limit` (the API uses `offset` and
  `limit` query params; `limit` max 20000)
- `accept: json` (using `format=geojson`)
- Rich query params: `starttime`, `endtime`, `minmagnitude`,
  `maxmagnitude`, `minlatitude`, `maxlatitude`, `minlongitude`,
  `maxlongitude`, `latitude`, `longitude`, `maxradiuskm`, `eventtype`,
  `eventid`, `orderby`, `catalog`, `contributor`, `reviewstatus`,
  etc. — 30+ filter params.
- Response shape: `itemsPath: features` (GeoJSON FeatureCollection
  identical to the summary feeds)
- Proposed name: `queryEvents`
- **Pagination probe needed** (Phase 0): verify `offset`/`limit` params
  work as expected and find the default `limit` ceiling. The docs say
  limit max is 20000. Default is null (service-defined, likely ~20000
  or smaller). The `gatherAll` setting should cap at 20000.
- **No helper needed** (query params are simple key=value, no date
  conversion required — ISO 8601 is already the native format).

### Group D — FDSN Count (1 endpoint, no pagination)

```
GET /fdsnws/event/1/count
```

- `via: restGet` (single integer response, no pagination)
- Accepts the same query params as `query` but returns a count, not a
  list.
- Proposed name: `countEvents`
- **No helper needed.**

### Group E — FDSN Metadata (5 endpoints, trivial)

```
GET /fdsnws/event/1/catalogs
GET /fdsnws/event/1/contributors
GET /fdsnws/event/1/application.json
GET /fdsnws/event/1/application.wadl
GET /fdsnws/event/1/version
```

- All `via: restGet`, `accept: json` (except `application.wadl` → XML
  and `version` → plain text; those use `accept: xml` / `accept: text`
  respectively).
- No params, no auth, no pagination.
- Low-value but trivially small (one-line YAML each). Proposed names:
  `listCatalogs`, `listContributors`, `getApplicationJson`,
  `getApplicationWadl`, `getVersion`.
- **No helpers needed.**

## Proposed operations summary

| Group | Ops to add | `via` | Notes |
|-------|-----------|-------|-------|
| A | 19 | `restGet` | GeoJSON summary feeds, all identical shape |
| B | 1 | `restGet` | GeoJSON detail by event ID |
| C | 1 | `paginate` | FDSN event query, offset-limit, needs probe |
| D | 1 | `restGet` | FDSN event count |
| E | 5 | `restGet` | FDSN metadata (catalogs, contributors, etc.) |
| **Total** | **27** | | |

## Implementation phases

### Phase -1 — Cache specs locally (skip)

Both docs pages are small and stateless (HTML pages fetched once by
`web-fetch` — done above). No PDFs or multi-page specs to cache. The
FDSN page fits on one HTML page. Skip.

### Phase 0 — Live shape probes (2 probes)

1. **Probe `query` pagination:** call
   `GET /fdsnws/event/1/query?format=geojson&limit=10&offset=1` and
   verify `metadata.count`, `features.length`, and that `offset=11`
   returns the next page. This confirms the `offset-limit` pagination
   style and determines the default/max limit for `gatherAll`.
2. **Probe `count` response shape:** call
   `GET /fdsnws/event/1/count?format=geojson&starttime=2026-01-01`
   and verify the count is a number, not a FeatureCollection.

### Phase 1 — Add Group A (GeoJSON Summary Feeds)

Add the 19 missing feed operations to `guide.md`. All use the same
YAML template:

```yaml
  - name: getSignificantHour
    via: restGet
    path: /earthquakes/feed/v1.0/summary/significant_hour.geojson
    accept: json
```

Mechanical work. Do Group A first because:

- Zero risk (same contract as `getAllHour`, already proven in prod)
- 19 ops in one pass establishes the full feed surface
- No helper or test changes needed for this group alone

### Phase 2 — Add Group B (GeoJSON Detail)

Add `getDetail` with path param `{eventId}`. Single operation, no
pagination, no helper.

### Phase 3 — Add Groups C+D (FDSN query + count)

Add `queryEvents` (paginated, needs Phase 0 probe results) and
`countEvents` (simple). These are the highest-value additions —
parameterized event search is what a research agent actually needs.

### Phase 4 — Add Group E (FDSN metadata, optional)

Add the 5 metadata operations. Low value but near-zero cost. Could be
deferred or skipped if the plan implementer considers them noise.

## Testing

Follow the boe.es pattern — two files, co-located:

1. **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated:
   Parses the recipe, executes every defined operation, asserts:
   - Group A (feeds): status 200, body has `type: "FeatureCollection"`,
     `features` is non-empty array.
   - Group B (detail): status 200, body has `type: "Feature"`.
   - Group C (query): status 200, `metadata.count >= 0`.
   - Group D (count): status 200, returns a number.
   - Group E (metadata): status 200, non-empty body.
   - One assertion per operation — same coverage density as the boe.es
     test.

2. **`helper.test.ts`** — Not needed. No helper transforms are
   proposed (the existing `helper.ts` is not touched). The boe.es
   expansion added zero helper code and this one won't either.

Manual: run `api-guide earthquake.usgs.gov` from a pi session, confirm
all ~28 ops appear with correct param hints.

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 19 missing summary feed ops (Phase 1), detail op (Phase 2), query+count ops (Phase 3), metadata ops (Phase 4) |
| `helper.ts` | Unchanged (no transforms needed) |
| `endpoint-coverage.test.ts` | Create with live coverage for every op |
| `helper.test.ts` | Unchanged (not created) |
| `spec/` | Not created (no PDFs or multi-page specs) |

## Out of scope / deliberate omissions

- **Mutating endpoints:** The USGS API has no documented write
  endpoints. All endpoints listed on the three docs pages are read-only
  GETs. Nothing omitted for auth/mutation reasons.
- **`format=kml` / `format=csv` / `format=quakeml` variants:** The
  FDSN `query` method supports output in multiple formats (GeoJSON,
  KML, CSV, QuakeML, text). We propose GeoJSON-only (`format=geojson`)
  as the standard `accept` — it returns JSON that the agent can
  directly consume. Adding format variants would multiply operations
  without adding research value. If a specific use case needs KML/CSV,
  add as a query param on the existing `queryEvents` operation.
- **`includearrivals`:** Documented but noted as "NOT CURRENTLY
  IMPLEMENTED" on the FDSN page. Will add automatically when the API
  supports it. Not adding a dedicated operation for it.
- **Event detail via FDSN `eventid` parameter:** The FDSN `query`
  method with `eventid` parameter returns the same data as the GeoJSON
  Detail feed, but in a different format (the `products` array is
  included automatically when `eventid` is specified). The dedicated
  `getDetail` operation (Group B) is cleaner for single-event lookups.
  No need to duplicate via `queryEvents` + `eventid`.

## Implementation notes

Implemented 2026-08 (rollout queue #1). All 28 operations shipped and
verified live (`HOST_INTEGRATION=1`: 29/29 pass; bare CI: 29 skip).
Group E was **fully implemented**, not skipped — the rollout table's
opt-in deviation was not needed; A1 holds for all 27 planned ops.

Phase 0 probe results that adjusted the plan (deviations from the
frozen text):

1. **`offset` is 1-based; `offset=0` → HTTP 400** (probe:
   `query?format=geojson&limit=2&offset=0` → 400). The plan assumed
   offset-limit would work with the paginator's 0 seed. Fixed at the
   root: `core/helpers.ts` `paginate()` now seeds the offset/page param
   from the recipe's declared `params.<pageParam>.default` when the
   caller omits it (one-line change; boe.es and every other guide are
   unaffected — they don't declare a default on their pageParam).
   `queryEvents` declares `params.offset.default: 1`. Covered by a new
   framework test in `__tests__/helpers.test.ts`.
2. **`offset-limit` now advances by the page size, not +1** (framework
   fix, same turn). The paginator previously advanced the offset param
   by 1 per page (page-index semantics), but every real offset API
   treats the param as a row offset (probed: BOE offset=1 shifts one
   row; USGS offset=11 skips 10). A +1 advance re-read the same rows
   (overlapping windows) on `gatherAll`. `advancePagination` now walks
   offset 0 → pageSize → 2·pageSize; APIs whose param is a true page
   number use `style: page` (unchanged +1). `api.github.com`'s
   pre-existing `searchRepos` was re-labeled to `style: page`
   accordingly (its `?page=N` is a page index); boe.es's
   `listConsolidada` needed no change and its `gatherAll` is now
   correct. Pinned by the "walks offset-limit" URL-progression
   assertions in `__tests__/helpers.test.ts`.
3. **`query` response metadata has no `count` key.** The plan's test
   spec ("`metadata.count >= 0`") was wrong; live metadata is
   `{generated, url, title, status, api, limit, offset}`. The test
   asserts the `features` array instead.
4. **`count` without `format` returns a bare number** (e.g. `370`),
   confirming the plan's "returns a number" spec. The `{count,
   maxAllowed, error}` object form only appears with
   `format=geojson`. Recipe declares no `format` param on
   `countEvents`; prose documents both forms and the over-limit error.
5. **`catalogs` / `contributors` return XML regardless of `Accept`**
   (even `?format=json` — probed). The plan said `accept: json`; the
   recipe uses `accept: xml` + `parse: {format: xml}`. Response shape:
   `<Catalogs><Catalog>…` / `<Contributors><Contributor>…`.
6. **Threshold/significant feeds can be legitimately empty**
   (`significant_hour` and `4.5_hour` had 0 features on the probe
   day). The plan's "features is non-empty array" assertion was
   relaxed to shape-only (`type: "FeatureCollection"` +
   `Array.isArray(features)`) for all 20 feeds.
7. **Detail `Feature` may lack `products`** (absent for the probed
   event `aka2026pjqoyy`; also `properties.detail` points at the FDSN
   `query?eventid=` form, not the `/detail/{id}.geojson` path). The
   test asserts `type: "Feature"` + properties only.
8. **`getVersion` uses `accept: text/plain`** — the plan's literal
   `accept: text` is not a valid media type. Cosmetic.
9. **`getDetail` declares no `params.eventId`** — the parser rejects
   re-declaring a `{token}` path param as a query param; the path
   param is inferred and documented in prose.
