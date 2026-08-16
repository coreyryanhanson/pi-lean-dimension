---
kind: api
schemaVersion: 0
domains:
  - openlibrary.org
shortName: Open Library
icon: 📖
apiHost: https://openlibrary.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-07-18"
docs: https://openlibrary.org/developers/api
operations:
  - name: searchBooks
    via: paginate
    path: /search.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: docs
      totalCountPath: numFound
      pageParam: start
      pageSizeParam: limit
      pageSize: 2
    params:
      q:
        description: Search query (required).
        required: true
      limit:
        description: Per-page count.
        default: 2

  # ── Group A — Author lookups ──────────────────────────────────────
  - name: searchAuthors
    via: paginate
    path: /search/authors.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: docs
      totalCountPath: numFound
      pageParam: start
      pageSizeParam: limit
      pageSize: 50
    params:
      q:
        description: Solr author query (required). See /search/howto for syntax.
        required: true
      limit:
        description: Per-page count.

  - name: getAuthor
    via: restGet
    path: /authors/{olid}.json
    accept: json

  - name: getWorksByAuthor
    via: paginate
    path: /authors/{olid}/works.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: entries
      totalCountPath: numFound
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
    params:
      limit:
        description: Per-page count (default 50 per docs).

  # ── Group B — Work & Edition lookups ──────────────────────────────
  - name: getWork
    via: restGet
    path: /works/{olid}.json
    accept: json

  - name: getEditionsByWork
    via: paginate
    path: /works/{olid}/editions.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: entries
      totalCountPath: numFound
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
    params:
      limit:
        description: Per-page count.

  - name: getEdition
    via: restGet
    path: /books/{olid}.json
    accept: json

  # ── Group C — Subjects ────────────────────────────────────────────
  - name: getSubject
    via: paginate
    path: /subjects/{subject}.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: works
      totalCountPath: numFound
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
    params:
      details:
        description: "true to include related subjects, prominent publishers, prolific authors, and publishing_history."
      ebooks:
        description: "true to include only works that have an e-book."
      published_in:
        description: Published-year range filter, e.g. 1500-1600.
      limit:
        description: Per-page count.

  # ── Group D — Recent changes (bare top-level array → restGet) ──────
  - name: getRecentChanges
    via: restGet
    path: /recentchanges.json
    accept: json
    params:
      type:
        description: Filter by object type, e.g. /type/page.
      key:
        description: Filter by object key, e.g. /books/OL1M.
      author:
        description: Filter by editor, e.g. /people/anand.
      bot:
        description: "true for only bot changes, false for only human changes."
      limit:
        description: Max entries (default 100, max 1000).
      offset:
        description: Skip offset entries (max 10000).

  - name: getRecentChangesByDate
    via: restGet
    path: /recentchanges/{year}/{month}/{day}.json
    accept: json
    params:
      limit:
        description: Max entries (default 100, max 1000).
      offset:
        description: Skip offset entries (max 10000).

  - name: getRecentChangesByKind
    via: restGet
    path: /recentchanges/{kind}.json
    accept: json
    params:
      limit:
        description: Max entries (default 100, max 1000).
      offset:
        description: Skip offset entries (max 10000).

  # ── Group E — Lists, read-only ────────────────────────────────────
  - name: getUserLists
    via: restGet
    path: /people/{username}/lists.json
    accept: json

  - name: getListsForSeed
    via: restGet
    path: /{seed_type}/{seed_id}/lists.json
    accept: json

  - name: searchLists
    via: restGet
    path: /search/lists.json
    accept: json
    params:
      q:
        description: Search query (required).
        required: true
      limit:
        description: Per-page count (max 100 per docs).
      offset:
        description: Skip offset entries.

  - name: getList
    via: restGet
    path: /people/{username}/lists/{list_id}.json
    accept: json

  - name: getListSeeds
    via: restGet
    path: /people/{username}/lists/{list_id}/seeds.json
    accept: json

  - name: getListEditions
    via: restGet
    path: /people/{username}/lists/{list_id}/editions.json
    accept: json
    params:
      limit:
        description: Per-page count.
      offset:
        description: Skip offset entries.

  - name: getListSubjects
    via: restGet
    path: /people/{username}/lists/{list_id}/subjects.json
    accept: json
    params:
      limit:
        description: Per-page count.
      offset:
        description: Skip offset entries.

  # ── Group F — Read API, single-request ────────────────────────────
  - name: getVolumeById
    via: restGet
    path: /api/volumes/brief/{id_type}/{id_value}.json
    accept: json

  # ── Group G — Infogami /query.json (open param surface → passthrough) ──
  - name: queryThings
    via: restGet
    path: /query.json
    accept: json
    passthrough: true
    params:
      type:
        description: >
          Infogami object type (the required `type` query param), e.g.
          /type/edition, /type/work, /type/author, /type/doc.
        required: true
      limit:
        description: Max results (default 20, max 1000 per docs).
      offset:
        description: Skip offset results.
---
# Open Library — Search API (G9: mixed field naming)

Open Library exposes bibliographic search with **no auth**. Internet Archive
open data; bibliographic metadata is CC0-ish.

> Expanded 2026-08 (rollout Batch C) to cover 20 read-only endpoints across
> 7 families. Path params (`{olid}`, `{subject}`, `{username}`,
> `{list_id}`, `{seed_type}`, `{seed_id}`, `{year}`/`{month}`/`{day}`,
> `{kind}`, `{id_type}`, `{id_value}`) are inferred from `{token}` in each
> `path:` and passed as positional path values — see each family below for
> valid values.

## Operations

### `searchBooks` — search books

`GET /search.json?q=…&limit=2` returns a body with **aliased field naming**:

```json
{
  "numFound": 912, "start": 0, "numFoundExact": true,
  "num_found": 912, "offset": null,
  "docs": [ { "title": "…", "author_name": ["…"], "first_publish_year": 1954 } ]
}
```

## How G9 fires

**Both `numFound` (camelCase) and `num_found` (snake_case) are present and
aliased** in one body; `offset` is even `null`. A field accessor that assumes
one naming convention will half-work. `itemsPath: docs` resolves fine; the
stress is on `parseResponse`/field accessors that read count/offset metadata —
they must tolerate aliased naming instead of asserting one convention.

Pagination is offset-limit via `start` (offset) / `limit` (page size).

## Expanded operation families

### Group A — Author lookups

- **`searchAuthors`** — `GET /search/authors.json?q=…`, Solr author search.
  Same `{numFound, start, docs}` envelope as `searchBooks`; `itemsPath: docs`,
  offset-limit via `start`/`limit`.
- **`getAuthor`** — `GET /authors/{olid}.json`. Single author record;
  `{olid}` is an author OLID, e.g. `OL23919A`.
- **`getWorksByAuthor`** — `GET /authors/{olid}/works.json`. All works of an
  author, `{size, links, entries}` envelope; `itemsPath: entries`, offset-limit
  via `offset`/`limit` (default page size 50).

### Group B — Work & Edition lookups

- **`getWork`** — `GET /works/{olid}.json`. Single work record; `{olid}` is a
  work OLID, e.g. `OL15626917W`.
- **`getEditionsByWork`** — `GET /works/{olid}/editions.json`. Editions of a
  work, `itemsPath: entries`, offset-limit via `offset`/`limit`.
- **`getEdition`** — `GET /books/{olid}.json`. Single edition record;
  `{olid}` is an edition OLID, e.g. `OL7170815M`.

### Group C — Subjects

- **`getSubject`** — `GET /subjects/{subject}.json`. Works on a subject,
  `itemsPath: works`, offset-limit via `offset`/`limit`. `{subject}` is a
  subject slug, e.g. `love` or `place:san_francisco`. Optional `details`
  (bool), `ebooks` (bool), `published_in` (year range e.g. `1500-1600`).

### Group D — Recent changes (bare top-level array → `restGet`)

These return a bare top-level JSON array (no `itemsPath` possible), so they
use `restGet` with manual `limit`/`offset`; the caller pages via params.

- **`getRecentChanges`** — `GET /recentchanges.json`. Filters via `type`
  (e.g. `/type/page`), `key` (e.g. `/books/OL1M`), `author` (e.g. `/people/anand`),
  `bot`.
- **`getRecentChangesByDate`** — `GET /recentchanges/{year}/{month}/{day}.json`.
  Day-granularity. `{month}`/`{day}` are zero-padded (e.g. `2026/08/05`).
  Coarser year-only and month-only forms are omitted.
- **`getRecentChangesByKind`** — `GET /recentchanges/{kind}.json`.
  `{kind}` enum: `add-cover`, `add-book`, `edit-book`, `merge-authors`,
  `update`, `revert`, `new-account`, `register`, `lists`.

### Group E — Lists, read-only

- **`getUserLists`** — `GET /people/{username}/lists.json`. A user's public lists.
- **`getListsForSeed`** — `GET /{seed_type}/{seed_id}/lists.json`. Lists
  containing a seed. `{seed_type}` ∈ {`books`, `works`, `authors`, `subjects`};
  `{seed_id}` is the OLID (books/works/authors) or a subject slug (subjects).
- **`searchLists`** — `GET /search/lists.json?q=…`. `limit` max 100, `offset`.
- **`getList`** — `GET /people/{username}/lists/{list_id}.json`. List metadata;
  `{list_id}` e.g. `OL97L`.
- **`getListSeeds`** — `GET /people/{username}/lists/{list_id}/seeds.json`.
- **`getListEditions`** — `GET /people/{username}/lists/{list_id}/editions.json`.
  `limit`/`offset`.
- **`getListSubjects`** — `GET /people/{username}/lists/{list_id}/subjects.json`.
  `limit`/`offset`.

### Group F — Read API (legacy)

- **`getVolumeById`** — `GET /api/volumes/brief/{id_type}/{id_value}.json`.
  Legacy Read API. `{id_type}` ∈ {`isbn`, `lccn`, `oclc`, `olid`}; `{id_value}`
  is the identifier, e.g. `9780385533225` for an ISBN. Returns
  readable/borrowable volume info + bibliographic `records`.

### Group G — Infogami `/query.json` (open param surface)

- **`queryThings`** — `GET /query.json?type=…&<property>=…`. Flat Infogami
  query. Declares `type` (required), `limit`, `offset`; with `passthrough:
  true`, any **other** caller-supplied key (e.g. `isbn_10`, `authors`, `title`)
  is forwarded to the query string as-is instead of being dropped. This is
  the escape hatch for the open-param-surface API.

## Terms

Internet Archive / Open Library open data. <https://openlibrary.org/developers/api>
