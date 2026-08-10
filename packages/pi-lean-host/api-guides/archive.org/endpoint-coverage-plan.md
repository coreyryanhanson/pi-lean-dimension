# Internet Archive API — Endpoint Coverage Plan

> Drafted 2026-07-21 against the live docs pages:
>
> - Item Metadata API: <https://archive.org/developers/metadata.html>
> - Metadata Read: <https://archive.org/developers/md-read.html>
> - Metadata Record details: <https://archive.org/developers/md-record.html>
> - Changes API: <https://archive.org/developers/changes.html>
> - Views API: <https://archive.org/developers/views_api.html>
> - Simple Lists: <https://archive.org/developers/simplelists.html>
> - Reviews API: <https://archive.org/developers/reviews.html>
>
> Verified by `curl` on 2026-07-21. Covers the read-only endpoints
> the current `guide.md` does not yet include.

## Status quo

`guide.md` declares **1 of ~6** documented read-only endpoint groups:

| Implemented | Operation | Path |
|-------------|-----------|------|
| ✅ | `getItemMetadata` | `/metadata/{identifier}` |

## Verification (2026-07-21)

Fetched all docs pages with `curl`. The Internet Archive developer
portal is a Sphinx-generated static site (no JS rendering needed). The
relevant APIs are organised into sub-pages under "Tools and APIs" in the
sidebar.

### A. Metadata Read — 3 sub-endpoints

The existing `getItemMetadata` fetches the full item record. The docs
also document partial reads and array slicing:

| # | Endpoint | Description | In guide? |
|---|----------|-------------|-----------|
| 1 | `GET /metadata/{identifier}` | Full item metadata record (created, files[], metadata{}, server, etc.) | ✅ `getItemMetadata` |
| 2 | `GET /metadata/{identifier}/{field}` | Partial read of one top-level field (e.g. `/metadata/xfetch/server`) | ❌ |
| 3 | `GET /metadata/{identifier}/files?start=N&count=M` | Slice of the files array with start/count params | ❌ |

All three are read-only GETs, no auth required. Partial reads are useful
for agents that need just the `metadata.title` or the first few files
without fetching the full (sometimes multi-megabyte) record.

### B. Search API — 1 paginated endpoint

The Internet Archive Search API is at `/advancedsearch.php` — a Solr
wrapper that returns JSON. It does not have its own dedicated docs page
in the developer portal, but it is **referenced in the `simplelists.html`
docs** as the mechanism for listing collection children (e.g.
`https://archive.org/advancedsearch.php?q=simplelists__holdings:library_of_atlantis&fl=identifier&output=json&rows=10&page=1`),
so it is a documented endpoint.

```
GET /advancedsearch.php?q={query}&fl={field_list}&rows={page_size}&page={page_num}&output=json&sort[]={field}+{dir}
```

| # | Endpoint | Description | In guide? |
|---|----------|-------------|-----------|
| 4 | `GET /advancedsearch.php?q=...` | Full-text search across all items. Returns Solr-style envelope with `response.numFound`, `response.docs[]`. | ❌ |

**Params (useful subset):**

- `q` — query string (Solr syntax; supports field queries like `collection:opensource`)
- `fl` — comma-separated field list (defaults to a standard set; common fields: `identifier,title,description,creator,date,mediatype,collection,downloads`)
- `rows` — page size (max?)
- `page` — 1-based page number
- `sort[]` — sort specification, e.g. `date+desc`, `downloads+asc`
- `output` — format: `json` or `xml`

**Pagination:** Solr-style offset-limit. `page` maps to `start=(page-1)*rows`.
`rows` default appears to be 50 (standard Solr), max likely 10000.

**Response shape:**

```json
{
  "responseHeader": { "status": 0, "QTime": …, "params": {…} },
  "response": {
    "numFound": 957893,
    "start": 0,
    "docs": [ { "identifier": "…", "title": "…", … } ]
  }
}
```

### C. Views API — 3 read-only endpoints (separate host)

The Views API lives at `https://be-api.us.archive.org` — a different
subdomain from `apiHost`. All three endpoints are GET, no auth:

| # | Endpoint | Description | In guide? |
|---|----------|-------------|-----------|
| 5 | `GET /views/v1/short/{identifier}[,{identifier},...]` | Short view counts: `all_time`, `last_30day`, `last_7day` | ❌ |
| 6 | `GET /views/v1/long/{identifier}[,{identifier},...]` | Detailed view data with per-day breakdown by useragent category | ❌ |
| 7 | `GET /views/v1/detail/collection/{collection}/{start_YYYY-MM-DD}/{end_YYYY-MM-DD}` | Geo-region view data for a collection over a date range | ❌ |

⚠ **Note:** all three endpoints are on `be-api.us.archive.org`, not
`archive.org`. The current guide's `apiHost: https://archive.org` would
not route these correctly. Options:

1. Add a second `apiHost` entry (if the guide system supports it).
2. Use absolute URLs in `path` (unlikely to work with the router).
3. Omit Views API from the plan and note it as a future extension when
   multi-host support lands.
4. Flag that `be-api.us.archive.org` is a "beta" service (stated in
   docs) and may not have the same SLA.

**Recommendation:** Omit Views API from this expansion. The beta status

- separate host make it higher risk than value. Document in "Out of
scope" below.

### D. Simple Lists (read via Metadata API — 1 endpoint)

The Simple Lists relationship data is readable through the existing
Metadata API via a sub-field path:

| # | Endpoint | Description | In guide? |
|---|----------|-------------|-----------|
| 8 | `GET /metadata/{identifier}/simplelists` | List all parent-list relationships for a child item (returns JSON with list names as keys, each containing parent item and notes) | ❌ |

This is just a specific Metadata Read partial path — no new host, no
auth, no pagination. Low-value but trivially small.

### E. Changes API (out of scope — auth required, POST)

```
POST https://be-api.us.archive.org/changes/v1
Requires S3 access+secret keys with special `see_all_catalog_changes` privilege.
```

**Out of scope** — requires authentication with special privileges not
available to the general public. Documented here for completeness.

### F. Reviews API (read — out of scope — auth required)

```
GET /services/reviews.php?identifier={id}
Requires Authorization: LOW header with S3 keys.
```

**Out of scope** — requires S3 auth even for reads. Documented here for
completeness.

### G. Metadata Write / Tasks / OCR / PDF (out of scope)

All clearly write or transformation endpoints. Not listed.

## Grouping for implementation

### Group A — Metadata Partial Reads (2 operations)

Same host, same auth (none), same `responseShape` as `getItemMetadata`.
Both are `via: restGet` single-resource lookups.

| Operation | Path | Notes |
|-----------|------|-------|
| `getItemField` | `/metadata/{identifier}/{field}` | Path param `{field}`. Response wraps the value in `{"result": …}` |
| `getItemFilesSlice` | `/metadata/{identifier}/files?start={start}&count={count}` | Query params `start` (integer, default 0) and `count` (integer, default ?). Returns `{"result": […], "count": N}` |

**No helper needed** — straight path/param substitution.

### Group B — Search API (1 operation)

| Operation | Path | Notes |
|-----------|------|-------|
| `searchItems` | `/advancedsearch.php` | `via: paginate`, `style: offset-limit`. Query params: `q`, `fl`, `rows`, `page`, `sort[]`. Items path: `response.docs`. |

**Pagination probe needed:** verify `page` param works as 1-based offset
and determine max `rows`.

**No helper needed** — all params are simple key=value. The Solr query
syntax in `q` is already the native format.

## Proposed operations summary

| Group | Ops to add | `via` | Host match? | Notes |
|-------|-----------|-------|-------------|-------|
| A | 2 | `restGet` | ✅ same host | Metadata partial reads |
| B | 1 | `paginate` | ✅ same host | Search API, offset-limit |
| C | 3 | `restGet` | ❌ `be-api.us.archive.org` | Views API — deferred (see below) |
| D | 1 | `restGet` | ✅ same host | Simple Lists read (trivial) |
| **Total** | **4 (6 if C included)** | | | |

## Implementation phases

### Phase 0 — Live shape probes (1 probe)

1. **Probe Search API pagination:** call
   `GET /advancedsearch.php?q=test&fl=identifier&rows=1&page=1&output=json`
   and verify `response.docs` is an array, `response.numFound >= 0`, and
   `page=2` with `rows=1` returns a different identifier. This confirms
   the offset-limit behaviour and the items path.

### Phase 1 — Add Group A (Metadata Partial Reads)

Add `getItemField` and `getItemFilesSlice` to `guide.md`. Both are
one-line YAML entries. No helper changes needed.

```yaml
  - name: getItemField
    via: restGet
    path: /metadata/{identifier}/{field}
    accept: json
    pathParams:
      - identifier
      - field

  - name: getItemFilesSlice
    via: restGet
    path: /metadata/{identifier}/files
    accept: json
    pathParams:
      - identifier
    params:
      start:
        description: Index to start the file array slice. Default 0.
        default: 0
      count:
        description: Number of files to return.
```

### Phase 2 — Add Group B (Search API)

Add `searchItems` to `guide.md`. This is the highest-value addition —
parameterised search across the full Internet Archive corpus is what a
research agent actually needs.

```yaml
  - name: searchItems
    via: paginate
    path: /advancedsearch.php
    accept: json
    pagination:
      style: offset-limit
      itemsPath: response.docs
      limitParam: rows
      offsetParam: page
    params:
      q:
        description: Solr query string. Supports field queries like `collection:opensource`.
      fl:
        description: Comma-separated field list. Common fields: identifier, title, description, creator, date, mediatype, collection, downloads.
      sort:
        description: Sort specification, e.g. `date desc`, `downloads desc`.
```

### Phase 3 (optional) — Add Group D (Simple Lists)

Add `listItemRelationships` to `guide.md`. One-line YAML entry.

```yaml
  - name: listItemRelationships
    via: restGet
    path: /metadata/{identifier}/simplelists
    accept: json
    pathParams:
      - identifier
```

### Views API (Group C) — NOT added, see "Out of scope"

## Testing

Follow the boe.es pattern — one file, co-located:

1. **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated:
   Parses the recipe, executes every defined operation, asserts:
   - Group A (`getItemField`): status 200, body has `result` key.
   - Group A (`getItemFilesSlice`): status 200, body has `result` array.
   - Group B (`searchItems`): status 200, `response.numFound >= 0`,
     `response.docs` is non-empty array.
   - Phase 3 optional (`listItemRelationships`): status 200.

2. **`helper.test.ts`** — Not needed. No helper transforms are proposed.

Manual: run `api-guide archive.org` from a pi session, confirm all ~5
ops appear with correct param hints.

## Implementation notes (rollout Batch B, #4)

Shipped 2026-08: 3 ops added (`getItemField`, `getItemFilesSlice`, `searchItems`)
→ `guide.md` now has **4 ops** (1 existing + 3 new). Phase 0 probe results:

1. **`searchItems` `style: page`, not `offset-limit`.** Live probe showed
   `page` is a **1-based page index** (`start=(page-1)*rows`; `page=2&rows=1`
   → `start=1`). The framework's `offset-limit` advance moves the offset by
   the page size (row-offset semantics), which would skip pages on a
   page-index API. Switched to `style: page` (+1 advance). Also the schema's
   field names are `pageParam` / `pageSizeParam` / `pageSize` (the plan draft
   said `offsetParam` / `limitParam`, which don't exist).
2. **Group D `listItemRelationships` skipped (Phase 3 optional).** Live probe
   on common items (`nasa`, `gutenberg`, `opensource`) returns an HTTP 200
   error body `{"error":"Couldn't get 'simplelists' for item …"}` — no stable
   200-with-data to assert. Low value, so skipped per the plan's optional
   Phase 3. To add later, find an item with actual parent-list relationships
   and assert its shape here.
3. **The `sort[]` concern is moot.** Plain `sort=downloads desc` (non-array)
   returns identical sorted results to `sort[]=…`. No helper transform needed.
4. **`output=json` is required (added as a defaulted param).** Without
   `output=json` the Search API returns an HTML results page, not JSON. The
   recipe declares `output: { default: json }` so the paginator always sends it.

Group C (Views API) remains out of scope (different host, beta).

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 2 Metadata partial read ops (Phase 1), Search API op (Phase 2), optionally Simple Lists op (Phase 3) |
| `helper.ts` | Unchanged (no transforms needed) |
| `endpoint-coverage.test.ts` | Create with live coverage for every op |
| `helper.test.ts` | Unchanged (not created) |
| `spec/` | Not created (no PDFs or multi-page specs — all docs are single HTML pages) |

## Out of scope / deliberate omissions

- **Views API (Group C):** Three read-only endpoints documented, but
  hosted on `be-api.us.archive.org` (different subdomain from
  `apiHost: https://archive.org`). The guide system routes all
  operations to `apiHost` + `path`; cross-host calls would need either
  multi-host support (not implemented) or a separate guide. Additionally,
  the Views API is labelled "beta" in the docs. Deferred until the
  guide system supports host-per-operation or the Views API graduates.
- **Changes API:** POST-only, requires S3 keys with special
  `see_all_catalog_changes` privilege. Not a public read endpoint.
- **Reviews API:** Read requires S3 key auth (`Authorization: LOW`
  header). Not a no-auth public read endpoint.
- **Metadata Write / Tasks / OCR / PDF:** Write or transformation
  endpoints, not read-only information retrieval.
- **`sort[]` param syntax:** The Search API uses Solr-style `sort[]`
  array params (`sort[]=date+desc`). The `params` block in the guide
  documents this as a single `sort` param; if the HTTP transport
  doesn't support array-style params, this may need a helper transform
  to convert `sort: "date desc"` into `sort[]=date+desc`. Probe this
  during Phase 0. If needed, add a tiny helper — but only if the live
  probe proves it.
