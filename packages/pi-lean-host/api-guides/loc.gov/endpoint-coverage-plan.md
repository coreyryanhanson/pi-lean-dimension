# LoC (Library of Congress) API — Endpoint Coverage Plan

> Drafted 2026-07-21 against the live LoC JSON/YAML API docs, and
> **revised 2026-07-22** after a verification pass found that the
> original draft had missed the authoritative **API Endpoints** page.
>
> Docs pages consulted (all read with `web-fetch`; the pages are
> server-rendered HTML, no JS rendering needed):
>
> - JSON/YAML API overview: <https://www.loc.gov/apis/json-and-yaml/>
> - **API Endpoints** (authoritative endpoint reference):
>   <https://www.loc.gov/apis/json-and-yaml/requests/endpoints/>
> - Working Within Limits (faceting + deep-paging ceiling):
>   <https://www.loc.gov/apis/json-and-yaml/working-within-limits/>
>
> The **API Endpoints** page is the canonical list and was the source
> the original draft omitted; it documents the `/{format}/` family and
> the `/resource/{resource_id}/` endpoint that the earlier draft either
> missed or misclassified as "probe-only." This revision corrects both.

## Status quo

`guide.md` declares **2** read-only endpoint groups, both documented:

| Implemented | Operation | Path | Source |
|-------------|-----------|------|--------|
| ✅ | `listSearch` | `/search/` | API Endpoints page + overview + limits examples |
| ✅ | `getItem` | `/item/{id}` | API Endpoints page ("Item Endpoint" section) |

## Verification (2026-07-22)

The LoC JSON/YAML API has **no formal OpenAPI/Swagger spec**. The
**API Endpoints** page is the closest thing to an authoritative
reference: it lists each endpoint with its purpose, response attributes,
and `at=` access-attribute variants. The "Working Within Limits" page
adds the deep-paging ceiling (100,000 items per query) and documents the
`/search/index/{field}/` faceting endpoint in its "Using Faceting"
section.

All endpoints share a uniform envelope across content types:
`results[]` + `pagination{next,total,perpage}` + `facets{}` for
search-result endpoints; `item{}` + `resources[]` (+ `resource{}`,
`page{}`, `segments[]` for the resource endpoint) for item/resource
endpoints. Pagination is nextLink via the `sp` (1-based page) and `c`
(items per page, max 1000 recommended) params; `pagination.next` is a
fully-qualified URL. Format selector: `?fo=json` (the `Accept` header
alone is not sufficient). No auth — public domain US government data.

### Documented endpoints (from the API Endpoints page + limits page)

Search-result endpoints (all share `results[]` + `pagination` + `facets`):

| # | Endpoint | Where documented | In guide? |
|---|----------|------------------|-----------|
| 1 | `GET /search/?fo=json&q=...&c=...&sp=...` | API Endpoints page ("Search Result Endpoints" → `/search/`) | ✅ `listSearch` |
| 2 | `GET /collections/?fo=json&c=...&sp=...` | API Endpoints page ("`/collections/`") | ❌ |
| 3 | `GET /collections/{name}/?fo=json` | API Endpoints page ("`/collections/{name of collection}/`") | ❌ |
| 4 | `GET /{format}/?fo=json&q=...&c=...&sp=...` | API Endpoints page ("`/{format}/`"), with **10 documented format slugs**: `audio`, `books`, `film-and-videos`, `legislation`, `manuscripts`, `maps`, `newspapers`, `photos`, `notated-music`, `web-archives` | ❌ |
| 5 | `GET /search/index/{field}/?fo=json&at=facets,pagination` | Limits page, "Using Faceting" section (line 193) | ❌ |

Item / resource endpoints:

| # | Endpoint | Where documented | In guide? |
|---|----------|------------------|-----------|
| 6 | `GET /item/{item_id}/?fo=json` | API Endpoints page ("Item Endpoint" → `/item/{item_id}/`) | ✅ `getItem` |
| 7 | `GET /resource/{resource_id}/?fo=json` | API Endpoints page ("Resource Endpoint" → `/resource/{resource_id}/`, with its own response-attributes section: `cite_this`, `item`, `page`, `resource`, `resources`, `segments`) | ❌ |

→ **5 documented endpoints to add** (#2–5, #7). All read-only GETs, no
auth.

### Probe-only endpoints (NOT in official docs — lower priority)

These mirror the website's URL structure and return the same JSON
envelope, but are **not listed on the API Endpoints page**. They could
change without notice.

| # | Endpoint | Response shape | In guide? |
|---|----------|----------------|-----------|
| 8 | `GET /programs/?fo=json` | `{results[], pagination{...}}` — 34 programs listed | ❌ |

⚠ **Lowest confidence.** May be a website route that happens to return
JSON rather than a stable API endpoint. The API Endpoints page does not
mention it.

### Notes on endpoints deliberately not added

- **`/collections/{name}/?at=results`** — this is the **same documented
  endpoint as #3** (`/collections/{name}/`), just with the `at=results`
  access-attribute to scope the response to the items list. The API
  Endpoints page lists `at=results` as one of the access attributes for
  `/collections/{name}/`. Folding it into `getCollection` via the `at`
  param is cleaner than a separate op and respects the "one operation
  per documented endpoint" rule. See Group A2 notes.
- **`/free-to-use/`** — orientation portal page, not an API results
  list. Returns `type: orientation-portal` with no `results` or
  `pagination`. Not on the API Endpoints page.
- **Image/Text/Streaming micro-services** — separate services on
  `tile.loc.gov` with their own rate limits. The docs sidebar lists them
  under "Microservices," not the JSON/YAML API. Out of scope.
- **MARCXML endpoint** (`lccn.loc.gov/{id}/marcxml`) — documented in the
  limits page but returns XML MARC records: different format and host,
  XML-only, no JSON equivalent. Out of scope for a JSON-consuming
  research aide.

## Grouping for implementation

### Group A — Collections (documented, 2 operations)

| # | Operation | `via` | Path | Source | Notes |
|---|-----------|-------|------|--------|-------|
| A1 | `listCollections` | `paginate` | `/collections/` | API Endpoints page | Browse all 584+ collections. NextLink pagination, identical to `listSearch`. |
| A2 | `getCollection` | `restGet` | `/collections/{name}` | API Endpoints page | Single collection landing page. Returns collection metadata + (by default) a first page of items. Pass `at=results` to scope to the items list rather than adding a separate `listCollectionItems` op — the `at` param is a documented access attribute on this same endpoint. |

### Group B — Format endpoints (documented, 1 operation with path param)

| # | Operation | `via` | Path | Source | Notes |
|---|-----------|-------|------|--------|-------|
| B1 | `listItemsByFormat` | `paginate` | `/{format}` | API Endpoints page ("`/{format}/`") | Path param `{format}` with **10 documented enum values**: `audio`, `books`, `film-and-videos`, `legislation`, `manuscripts`, `maps`, `newspapers`, `photos`, `notated-music`, `web-archives`. Same search-result envelope as `/search/` (`results[]` + `pagination` + `facets`). |

This is **one documented endpoint** with a path-param enum, not 10
separate endpoints — so one operation with a `{format}` path param is
the correct shape (distinct from the boe.es rule that split
`getSumario`/`getSumarioBorme`, which were two separate documented
paths). The 10 slugs are the documented enum and should be declared on
the param so the agent knows the valid values.

### Group C — Search Index (documented, 1 operation)

| # | Operation | `via` | Path | Source | Notes |
|---|-----------|-------|------|--------|-------|
| C1 | `searchFieldIndex` | `paginate` | `/search/index/{field}` | Limits page, "Using Faceting" section | Enumerates facet values for a field (e.g. all `location` values matching a query). Helps agents discover facet values for refined searching. The limits page notes these queries are themselves resource-intensive, so the agent should avoid paginating through too large a list of values. |

### Group D — Resource endpoint (documented, 1 operation)

| # | Operation | `via` | Path | Source | Notes |
|---|-----------|-------|------|--------|-------|
| D1 | `getResource` | `restGet` | `/resource/{resource_id}` | API Endpoints page ("Resource Endpoint") | Path param `{resource_id}`. Returns `cite_this`, `item`, `page`, `resource`, `resources`, `segments` — discrete digitized files belonging to a multi-part item (e.g. individual pages of a digitized newspaper). Use `at=` to scope (the page lists `at=resource`, `at=page`, `at=segments`, etc.). |

**Why this is no longer "probe-only":** the API Endpoints page has a
dedicated "Resource Endpoint" section documenting `/resource/{resource_id}/`
with response attributes, examples, and access attributes. The original
draft's "probe-only / Not in docs" classification was wrong — it
resulted from only consulting the limits page, which mentions `/resource/`
only in passing. This revision reclassifies it as documented and moves it
to the high-priority group.

### Group E — Probe-only endpoints (1 operation, lower priority)

| # | Operation | `via` | Path | Source | Notes |
|---|-----------|-------|------|--------|-------|
| E1 | `listPrograms` | `paginate` | `/programs/` | probe-only | 34 programs. **NOT on the API Endpoints page.** ⚠ Lowest confidence — may be a website route that happens to return JSON, not a stable API endpoint. |

## Proposed operations summary

| Group | Ops to add | `via` | Priority | Confidence | Notes |
|-------|-----------|-------|----------|------------|-------|
| A | 2 | `paginate` / `restGet` | High | documented | Collections — browse + detail |
| B | 1 | `paginate` | High | documented | Items by original format (10 documented slugs) |
| C | 1 | `paginate` | Medium | documented | Field-value index for faceted search |
| D | 1 | `restGet` | High | documented | Resource endpoint — multi-part item files |
| E | 1 | `paginate` | Low | probe-only | Programs — NOT in docs |
| **Total** | **6** | | | | |

**Recommendation:** implement Groups A–D first (5 documented ops, all
stable and on the API Endpoints page). Group E is deferred until a use
case arises or the LoC adds `/programs/` to the endpoint reference.
Shipping probe-only endpoints risks breaking if LoC reorganizes their
URL structure.

## Implementation phases

### Phase -1 — Cache specs locally (skip)

No formal OpenAPI spec exists. The API Endpoints page is a single HTML
page (fetched above). No PDFs or multi-page specs to cache. Skip.

### Phase 0 — Live shape probe (1 quick probe)

Probe `/collections/` pagination to confirm `at=results` scoping and the
nextLink shape:

```bash
curl 'https://www.loc.gov/collections/vietnam-era-pow-mia-database/?fo=json&at=results&c=1&sp=1'
```

Verify:

- `results[]` is an array of item objects (same schema as `/search/`)
- `pagination.next` is a fully-qualified URL
- `sp=2` returns the next page

(No probe needed for Group B — the `/{format}/` endpoint shares the
exact same search-result envelope as `/search/`, which is already
proven in production via `listSearch`. No probe needed for Group D —
`/resource/{resource_id}/` is a single-resource `restGet` whose
response shape is documented on the API Endpoints page.)

### Phase 1 — Add Group A (Collections, documented)

Add two operations to `guide.md`. Both use the same YAML patterns as the
existing `listSearch` and `getItem`:

```yaml
  - name: listCollections
    via: paginate
    path: /collections/
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      nextLinkPath: pagination.next
    params:
      fo:
        description: Response format query param.
        default: json
      c:
        description: Items per page. Max 1000 recommended.
        default: 20
      sp:
        description: Page number (1-based). Omit for page 1.

  - name: getCollection
    via: restGet
    path: /collections/{name}
    accept: json
    pathParams:
      - name
    params:
      fo:
        description: Response format query param.
        default: json
      at:
        description: >
          Content sections to include. Use `item` for collection
          metadata only, `results` for the items list, or omit for
          metadata + first page of items.
        default: item
```

### Phase 2 — Add Group B (Items by format, documented)

One operation with a `{format}` path param. Declares the 10 documented
format slugs as the param's enum so the agent knows the valid values.

```yaml
  - name: listItemsByFormat
    via: paginate
    path: /{format}
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      nextLinkPath: pagination.next
    pathParams:
      - format
    params:
      fo:
        default: json
      q:
        description: Search term within the format-scoped results.
      c:
        description: Items per page. Max 1000 recommended.
        default: 20
      sp:
        description: Page number (1-based). Omit for page 1.
```

⚠ **`{format}` enum:** the 10 documented slugs are `audio`, `books`,
`film-and-videos`, `legislation`, `manuscripts`, `maps`, `newspapers`,
`photos`, `notated-music`, `web-archives`. If the guide schema supports
an `enum:` list on a path param, declare it; otherwise document the
valid values in the param `description`.

### Phase 3 — Add Group C (Search Index, documented)

```yaml
  - name: searchFieldIndex
    via: paginate
    path: /search/index/{field}
    accept: json
    pagination:
      style: nextLink
      itemsPath: facets
      nextLinkPath: pagination.next
    pathParams:
      - field
    params:
      fo:
        default: json
      fa:
        description: Facet filter to scope the index results.
      at:
        default: facets,pagination
```

### Phase 4 — Add Group D (Resource endpoint, documented)

```yaml
  - name: getResource
    via: restGet
    path: /resource/{resource_id}
    accept: json
    pathParams:
      - resource_id
    params:
      fo:
        default: json
      at:
        description: >
          Content sections to include (e.g. `resource`, `page`,
          `segments`, `item`, `cite_this`, `resources`).
```

### Phase 5 (deferred) — Group E (probe-only: programs)

Only implement if a use case arises AND the LoC adds `/programs/` to
the API Endpoints page. Add a note in `guide.md` flagging it as
undocumented if it ever lands.

### Response shape notes

All list endpoints return results in `results[]`. The `at` parameter
controls which sections appear; the default varies by content type —
explicitly passing `at=results` (or `at=item` for single entities) gives
the cleanest response for an agent.

## Testing

Follow the boe.es pattern — one file, co-located:

1. **`endpoint-coverage.test.ts`** — `HOST_INTEGRATION=1`-gated:
   Parses the recipe, executes every defined operation, asserts:
   - `listCollections`: status 200, `results` is non-empty array,
     `pagination.total >= 500`
   - `getCollection`: status 200, response has `title` or `description`
   - `listItemsByFormat` (e.g. `format=maps`): status 200, `results` is
     non-empty array, `pagination` present
   - `searchFieldIndex` (e.g. `field=location`): status 200, response
     has `facets` object
   - `getResource`: status 200, response has `resource` or `item`
     (use a real `resource_id` extracted from an item's `resources[]`
     in a `beforeAll`, or assert a stable known one)

   (Only test ops that are actually implemented — Groups A–D in the
   first pass. Add Group E assertions only if that op lands.)

2. **`helper.test.ts`** — Not needed. No helper transforms are proposed.

Manual: run `api-guide loc.gov` from a pi session, confirm all
implemented ops appear with correct param hints.

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 2 Collections ops (Phase 1), 1 format op (Phase 2), 1 search-index op (Phase 3), 1 resource op (Phase 4). Group E only if confirmed. |
| `helper.ts` | Unchanged (no transforms needed) |
| `endpoint-coverage.test.ts` | Create with live coverage for implemented ops |
| `helper.test.ts` | Unchanged (not created) |
| `spec/` | Not created (no formal spec exists; endpoint shapes from the API Endpoints page + limits page + live probe) |

## Out of scope / deliberate omissions

- **Probe-only endpoints (`/programs/`):** Not on the API Endpoints
  page. Found by probing the live API. Deferred (Group E) until
  documented or a confirmed use case arises. Shipping undocumented
  endpoints risks breakage if LoC reorganizes URLs.
- **`listCollectionItems` as a separate op:** the `/collections/{name}/`
  endpoint already returns items via the `at=results` access attribute
  on the same path as `getCollection` (documented on the API Endpoints
  page). A separate op would violate the "one operation per documented
  endpoint" rule. Reuse `getCollection` with `at=results` instead.
- **Image/Text/Streaming micro-services:** Documented in the docs
  sidebar under "Microservices" as separate services on `tile.loc.gov`
  with different rate limits. File-serving services, not metadata APIs.
  Out of scope.
- **MARCXML endpoint** (`lccn.loc.gov/{id}/marcxml`): Documented in the
  limits page but returns XML MARC records — a different format and
  host. XML-only, no JSON equivalent. Add as a separate `accept: xml` op
  later if needed.
- **`/free-to-use/`:** Portal page, not an API results list. Not on the
  API Endpoints page.
- **`?fo=yaml` variants:** The API also supports YAML output via
  `fo=yaml`. Not adding YAML variants — JSON is the standard format for
  programmatic consumption.

## Implementation notes (2026-08, Batch B rollout)

**Shipped:** all 5 planned operations from Groups A–D landed in `guide.md`
(`listCollections`, `getCollection`, `listItemsByFormat`, `searchFieldIndex`,
`getResource`), giving 7 ops total. Group E (`listPrograms`) remains deferred
as planned. No `helper.ts`, no `helper.test.ts`. Live gate green
(`HOST_INTEGRATION=1` 8/8; the two restGet ops showed transient Cloudflare
timeouts under concurrent full-suite runs but pass reliably otherwise — C2
best-effort). Bare CI green (8 skip). Repo `npm run test:ci` green.

Deviations from the frozen plan (all from Phase 0 live probes):

1. **`getCollection` `at` default dropped.** The plan's YAML proposed
   `at: { default: item }`. A live probe showed `at=item` returns an empty
   `{}` on collections — `item` is an item-endpoint access attribute, not a
   collection one. The op now documents `at=results` (scope to the items
   list) / omit (full metadata + first page of items) with no default, and
   the test asserts `title` from the default full-page response.
2. **`listCollections` total assertion lowered.** The plan suggested
   `pagination.total >= 500`; live shows `total: 292`. Test asserts a
   non-empty `results` array instead (matches the hands-off `> 0` style).
3. **`searchFieldIndex` `itemsPath: facets` confirmed.** Live response's
   `facets` is a list of filter-group objects (each with a `filters[]`
   sub-array, e.g. `[{filters: [{title, value, count, on, off}], ...}]`),
   and `pagination.next` is present. No recipe change needed.
4. **`{format}` enum documented in description, not `enum:`.** The guide
   schema's `QueryParamSpec` has no `enum` field, so the 10 documented slugs
   were written into the param description (per the plan's own fallback).
5. **Slash-containing item/resource ids are rejected by the pipeline.** The
   path token is `encodeURIComponent`-ed in `core/helpers.ts`, so an id like
   `powmia/pwmaster_1` becomes `powmia%2Fpwmaster_1` and LoC returns an HTML
   page (not JSON). Tests use slash-free ids (`item/2001704258`,
   `resource/pga.03206`). Not a plan change — the plan nominated no test ids
   — but recorded so future implementers pick flat ids.
