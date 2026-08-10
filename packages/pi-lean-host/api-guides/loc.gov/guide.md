---
kind: api
domains:
  - loc.gov
  - www.loc.gov
shortName: LoC
icon: 📚
apiHost: https://www.loc.gov
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-07-18"
docs: https://www.loc.gov/apis/json-and-yaml/working-within-limits/
operations:
  - name: listSearch
    via: paginate
    path: /search/
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      totalCountPath: search.hits
      nextLinkPath: pagination.next
    params:
      fo:
        description: >
          Response format. LoC uses a query param (not the Accept header) to
          select JSON: pass `json`. Defaulted to `json` so callers can omit it.
        default: json
      q:
        description: >
          Free-text search query. Omit to browse the whole catalog (the
          endpoint returns a non-empty first page with no query).
      c:
        description: >
          Per-page count (LoC's `c` param). Defaulted to a small page for
          smoke tests; raise it to fetch faster.
        default: 10
  - name: getItem
    via: restGet
    path: /item/{id}
    accept: json
    params:
      fo:
        description: Response format query param; defaulted to `json`.
        default: json
  # ── Group A — Collections (documented, API Endpoints page) ──
  - name: listCollections
    via: paginate
    path: /collections/
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      totalCountPath: search.hits
      nextLinkPath: pagination.next
    params:
      fo:
        description: Response format query param; defaulted to `json`.
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
    params:
      fo:
        description: Response format query param; defaulted to `json`.
        default: json
      at:
        description: >
          Content sections to include. `results` scopes to the items list;
          omit for collection metadata plus the first page of items.
          (`at=item` returns an empty object on collections — see plan notes.)
  # ── Group B — Items by format (documented, `/{format}/` endpoint) ──
  - name: listItemsByFormat
    via: paginate
    path: /{format}
    accept: json
    pagination:
      style: nextLink
      itemsPath: results
      totalCountPath: search.hits
      nextLinkPath: pagination.next
    params:
      fo:
        description: Response format query param; defaulted to `json`.
        default: json
      q:
        description: Search term within the format-scoped results.
      c:
        description: Items per page. Max 1000 recommended.
        default: 20
      sp:
        description: Page number (1-based). Omit for page 1.
  # ── Group C — Search index (documented, limits page "Using Faceting") ──
  - name: searchFieldIndex
    via: paginate
    path: /search/index/{field}
    accept: json
    pagination:
      style: nextLink
      itemsPath: facets
      totalCountPath: search.hits
      nextLinkPath: pagination.next
    params:
      fo:
        description: Response format query param; defaulted to `json`.
        default: json
      fa:
        description: Facet filter to scope the index results.
      at:
        description: Content sections to include.
        default: facets,pagination
  # ── Group D — Resource endpoint (documented, API Endpoints page) ──
  - name: getResource
    via: restGet
    path: /resource/{resource_id}
    accept: json
    params:
      fo:
        description: Response format query param; defaulted to `json`.
        default: json
      at:
        description: >
          Content sections to include (e.g. `resource`, `page`, `segments`,
          `item`, `cite_this`, `resources`).
---

> Rollout Batch B: 5 operations added (Groups A–D). The `{format}` path
> param has **10 documented enum values**: `audio`, `books`,
> `film-and-videos`, `legislation`, `manuscripts`, `maps`, `newspapers`,
> `photos`, `notated-music`, `web-archives` (the guide schema has no `enum:`
> field, so valid values are documented here instead).
>
# LoC — Library of Congress JSON API

The Library of Congress JSON API exposes the catalog, items, and collections
with **no authentication**. US federal government works are public domain; the
API docs state the endpoint is *"accessible to the public with no API key or
authentication required"*.

## Operations

### `listSearch` — search the catalog (nextLink pagination)

`GET /search/?fo=json&q=…&c=…` returns a page of results. The next-page URL is
**server-supplied** as a fully-formed string at `pagination.next` — the client
follows it verbatim and never computes page math. This is the nextLink path
that also exercises the built-in `ssrfGuard` (the one place the URL comes from
the remote server).

```json
{
  "pagination": { "next": "https://www.loc.gov/search/?c=10&fo=json&q=earthquake&sp=2", "current": 1, "perpage": 10, "total": 207925 },
  "results": [ { "title": "...", "id": "...", "url": "..." } ]
}
```

Pass `gatherAll: true` to `api-fetch` to accumulate results up to the guide
ceiling.

### `getItem` — fetch a single item by ID

`GET /item/{id}?fo=json` returns one item record. Non-paginated `restGet`.

## Additional operations (rollout Batch B)

The 5 operations below were added during the rollout from the
`endpoint-coverage-plan.md` audit (Groups A–D). All are read-only, no auth.

### `listCollections` — browse all collections (nextLink pagination)

`GET /collections/` shares the `/search/` search-result envelope (`results[]` + `pagination.next`). ~292 collections. Same nextLink shape as `listSearch`.

### `getCollection` — a single collection landing page

`GET /collections/{name}` returns the collection's metadata plus (by default)
a first page of items. Pass `at=results` in the `at` param to scope the
response to just the items list. (Live probe: `at=item` returns an empty `{}`
on collections, so the op omits that access attribute and favors the full page
or `at=results`.)

### `listItemsByFormat` — items in one original format

`GET /{format}` scopes results to a format slug. The `{format}` path param
has **10 documented enum values**: `audio`, `books`, `film-and-videos`,
`legislation`, `manuscripts`, `maps`, `newspapers`, `photos`,
`notated-music`, `web-archives`. Same search-result envelope as `/search/`.

### `searchFieldIndex` — enumerate facet values for a field

`GET /search/index/{field}` lists the distinct values (and counts) for a
facet field (e.g. all `location` values matching a query), returned in a
`facets[]` array of filter-group objects. These queries are resource-intensive
per the limits page — avoid deep pagination.

### `getResource` — a digitized file of a multi-part item

`GET /resource/{resource_id}` returns the discrete digitized files of a
multi-part item (e.g. individual pages of a digitized newspaper) as
`resource{}` alongside `cite_this`, `item`, `resources[]`, etc. Use the `at`
param to scope to `resource`, `page`, `segments`, etc.

## Notes & schema gaps (escape-valve evidence)

- **ETag (bonus axis D):** the response carries an `etag` header; the
  transport's conditional-GET path fires automatically on repeats. LoC's ETag
  is incidental bonus, not the candidate's purpose (see `en.wikipedia.org` for
  the dedicated axis D recipe).
- **Format via query param:** `fo=json` selects JSON — the `Accept` header
  alone is not enough. The recipe defaults `fo: json` so callers can omit it;
  this is the same "query-param content negotiation" shape as MusicBrainz
  (`fmt=`) and Wikidata (`format=`).
- **`robots.txt`:** disallows `/search` for web crawlers — a crawl-optimization
  rule, not an API ToS restriction. The JSON endpoint is the documented API.

## Terms

US federal government work — public domain. API docs:
<https://www.loc.gov/apis/json-and-yaml/working-within-limits/>
