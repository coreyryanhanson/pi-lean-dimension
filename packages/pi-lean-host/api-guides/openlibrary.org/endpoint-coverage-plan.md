# Open Library API — Endpoint Coverage Plan

> Drafted 2026-07-20 against the live docs hub
> <https://openlibrary.org/developers/api> and its sub-pages (verified by
> `web-fetch` on 2026-07-20; the RESTful API page's code blocks were
> extracted via `browser-console` because the markdown converter elided
> them). Implements the **19** read-only endpoints the current `guide.md`
> does not yet cover (18 fixed-shape ops + 1 open-param-surface op that
> exercises the new `passthrough` recipe flag).

## Status quo

`guide.md` declares **1 of ~20** documented read-only endpoints:

| Implemented | Operation | Path |
|-------------|-----------|------|
| ✅ | `searchBooks` | `/search.json` |

The single shipped op targets the Solr works search. Everything else —
author/work/edition lookups, editions-of-work, works-of-author, subjects,
recent changes, lists, and the legacy Read API — is missing.

## Verification (2026-07-20)

The docs URL is a **hub**. The authoritative endpoint list is spread
across 9 sub-pages linked from the "Index of APIs" + "More APIs" sections.
Each sub-page was fetched and parsed:

| Sub-page | URL | Status |
|----------|-----|--------|
| Search | <https://openlibrary.org/dev/docs/api/search> | ✅ fetched |
| Authors | <https://openlibrary.org/dev/docs/api/authors> | ✅ fetched |
| Subjects | <https://openlibrary.org/dev/docs/api/subjects> | ✅ fetched |
| Recent Changes | <https://openlibrary.org/dev/docs/api/recentchanges> | ✅ fetched |
| Lists | <https://openlibrary.org/dev/docs/api/lists> | ✅ fetched |
| My Books | <https://openlibrary.org/dev/docs/api/mybooks> | ✅ fetched (out-of-scope) |
| Covers | <https://openlibrary.org/dev/docs/api/covers> | ✅ fetched (out-of-scope) |
| Search inside | <https://openlibrary.org/dev/docs/api/search_inside> | ✅ fetched (out-of-scope) |
| RESTful API | <https://openlibrary.org/dev/docs/restful_api> | ✅ fetched (code blocks via `browser-console`) |
| Read API (legacy) | <https://openlibrary.org/dev/docs/api/read> | ✅ fetched |
| JSON API (legacy) | <https://openlibrary.org/dev/docs/json_api> | ✅ fetched (deprecated) |
| Work & Edition | <https://openlibrary.org/dev/docs/api/books> | ❌ **404** (page gone; resource patterns recovered from the RESTful API "Content" section + "More APIs") |

The "Work & Edition" sub-page (`/dev/docs/api/books`) returns HTTP 404
(`{"detail":"Not Found"}`) on both `web-fetch` and `browser-navigate`. The
resource-access patterns it would have documented (`/works/{OLID}.json`,
`/books/{OLID}.json`, `/works/{OLID}/editions.json`) are nevertheless
**authoritatively documented** in two places that still resolve: the
RESTful API "Content" section (code blocks extracted via `browser-console`,
showing `/works/OL27258W/editions.json?limit=5` and `/authors/OL1A/works.json`)
and the hub's "More APIs" section (showing
`https://openlibrary.org/works/OL15626917W.json` and
`https://openlibrary.org/authors/OL33421A.json`, plus the `.json`/`.rdf`/`.yml`
extension convention for any OL identifier). No endpoint is inferred from
probing alone; the four Phase-0 probes below only confirm response *field
names* for endpoints already documented in prose.

### Authoritative endpoint list

```
Search family
  GET /search.json                                  ✅ searchBooks (existing)
  GET /search/authors.json?q=…                      ❌ searchAuthors

Resource lookups (the ".json on any OL identifier" convention)
  GET /authors/{olid}.json                          ❌ getAuthor
  GET /authors/{olid}/works.json                    ❌ getWorksByAuthor
  GET /works/{olid}.json                            ❌ getWork
  GET /works/{olid}/editions.json                   ❌ getEditionsByWork
  GET /books/{olid}.json                            ❌ getEdition

Subjects
  GET /subjects/{subject}.json                      ❌ getSubject

Recent Changes
  GET /recentchanges.json                           ❌ getRecentChanges
  GET /recentchanges/{YYYY}/{MM}/{DD}.json          ❌ getRecentChangesByDate
  GET /recentchanges/{KIND}.json                    ❌ getRecentChangesByKind

Lists (read-only GETs only)
  GET /people/{username}/lists.json                 ❌ getUserLists
  GET /{seed_type}/{seed_id}/lists.json             ❌ getListsForSeed
  GET /search/lists.json?q=…                        ❌ searchLists
  GET /people/{username}/lists/{list_id}.json       ❌ getList
  GET /people/{username}/lists/{list_id}/seeds.json ❌ getListSeeds
  GET /people/{username}/lists/{list_id}/editions.json ❌ getListEditions
  GET /people/{username}/lists/{list_id}/subjects.json ❌ getListSubjects

Read API (legacy, read-only)
  GET /api/volumes/brief/{id_type}/{id_value}.json  ❌ getVolumeById

Infogami query (open param surface)
  GET /query.json?type=…&<any property>=…          ❌ queryThings (passthrough)
```

→ **19 endpoints to add.**

### Out-of-scope rows (documented but excluded)

| Endpoint | Reason |
|----------|--------|
| Covers API `https://covers.openlibrary.org/b/{key}/{value}-{size}.jpg` (and `/a/…`) | Different host (`covers.openlibrary.org`) + binary **image** responses. The `.json` cover-metadata variant (`covers.openlibrary.org/b/id/{id}.json`) is also on the covers host. Not a fit for the `openlibrary.org` JSON guide. |
| Search inside `https://ia800204.us.archive.org/fulltext/inside.php?…` | Dynamic archive.org **data-node host** (resolved per-item from `archive.org/metadata/{id}` `d1`/`d2`); not a stable `openlibrary.org` endpoint. Experimental. |
| My Books `/people/{user}/books/{want-to-read\|currently-reading\|already-read}.json` | Patron **reading logs** — personal data requiring auth or a public-account setting. Not public bibliographic research data; the guide is `auth: none`. |
| Lists `POST /people/{user}/lists` (create), `POST …/lists/{id}/delete.json`, `POST …/lists/{id}/seeds` (add/remove), `PUT …/list/{id}` (update) | **Mutations** (create/update/delete). Out of scope per the audit rules. |
| Read API multi-request `GET /api/volumes/brief/json/{request-list}` | Non-standard **semicolon/pipe-delimited path** (`id:1;lccn:50006784\|olid:OL6179000M;lccn:55011330`), awkward to model in the recipe schema; the single-request form covers the same data. |
| Legacy JSON API `/api/things`, `/api/get`, `/api/versions`, `/api/search` | Hub page labels it "**Legacy … deprecated**". The current RESTful API (`/query.json`, `/{key}.json`) and the resource-lookup ops cover the same ground. `/api/search` is additionally marked "deprecated and not maintained." |
| `?m=history` on any resource (e.g. `/books/OL1M.json?m=history`) | Expressible today via a fixed-value query param (`m: { default: "history" }` on a resource-lookup op) — NOT a schema limit. Deferred on value grounds: edit metadata is marginal for a research aide, and one op per resource type is modeling verbosity. Revisit if a concrete need arises. |
| `/query.json` flat form (open param surface) | Now covered via the **`passthrough`** recipe flag (see Group G) — the caller supplies type-specific property keys at query time and they reach the wire as-is. |
| `POST /account/login` | Auth / mutation. |
| `PUT /resource` (Save) | Mutation; docs say "internal API, works only from localhost." |

## Phase 0 — Live shape probe (2026-07-20)

Confirmed response field names for the paginated endpoints (the docs
show elided `[code code …]` samples; a light probe nails the `itemsPath`):

| Endpoint | Probe | Result → `itemsPath` / pagination |
|----------|-------|-----------------------------------|
| `/search/authors.json?q=rowling&limit=2` | `curl` | `{numFound, start, docs:[…]}` → `itemsPath: docs`, offset-limit via `start`/`limit` |
| `/works/OL27258W/editions.json?limit=2` | `curl` | `{links:{next}, size, entries:[…]}` → `itemsPath: entries`, offset-limit via `offset`/`limit` (`links.next` also present) |
| `/subjects/love.json?limit=2` | `curl` | `{work_count, works:[…]}` → `itemsPath: works`, offset-limit via `offset`/`limit` |
| `/recentchanges.json?limit=2` | `curl` | **bare top-level array** `[{…}]` — no `itemsPath` possible (the parser rejects empty `itemsPath`), so this family uses `via: restGet` with manual `limit`/`offset` params, not `paginate` |

`/authors/{olid}/works.json` shares the `{size, links, entries}` envelope
of the editions probe (documented in the Authors page) → `itemsPath: entries`,
offset-limit via `offset`/`limit`. No separate probe needed.

## Grouping for implementation

19 endpoints in 7 families. Implement family-by-family, smallest/highest-
value first. No `helper.ts` transform is needed for any of these — all
params are plain strings/enums passed straight through (Group G forwards
freeform keys via the `passthrough` flag, not a helper). **Zero helper
code**, like the boe.es expansion.

### Group A — Author lookups (3 ops)

| Op | Via | Path | Notes |
|----|-----|------|-------|
| `searchAuthors` | `paginate` | `/search/authors.json` | `q` required; offset-limit `start`/`limit`, `itemsPath: docs`. Same envelope as the existing `searchBooks`. |
| `getAuthor` | `restGet` | `/authors/{olid}.json` | Single author record. `{olid}` e.g. `OL23919A`. |
| `getWorksByAuthor` | `paginate` | `/authors/{olid}/works.json` | offset-limit `offset`/`limit`, `itemsPath: entries`. Default page size 50 per docs. |

### Group B — Work & Edition lookups (3 ops)

| Op | Via | Path | Notes |
|----|-----|------|-------|
| `getWork` | `restGet` | `/works/{olid}.json` | Single work record. `{olid}` e.g. `OL15626917W`. |
| `getEditionsByWork` | `paginate` | `/works/{olid}/editions.json` | offset-limit `offset`/`limit`, `itemsPath: entries`. `links.next` present but offset-limit is the documented param shape. |
| `getEdition` | `restGet` | `/books/{olid}.json` | Single edition record. `{olid}` e.g. `OL7170815M`. |

### Group C — Subjects (1 op)

| Op | Via | Path | Notes |
|----|-----|------|-------|
| `getSubject` | `paginate` | `/subjects/{subject}.json` | offset-limit `offset`/`limit`, `itemsPath: works`. Params: `details` (bool: include related subjects/publishers/authors/publishing_history), `ebooks` (bool: only ebook works), `published_in` (year range e.g. `1500-1600`). `{subject}` is a subject slug e.g. `love` or `place:san_francisco`. |

### Group D — Recent changes (3 ops, all `restGet` — bare array)

| Op | Via | Path | Notes |
|----|-----|------|-------|
| `getRecentChanges` | `restGet` | `/recentchanges.json` | Params: `type` (filter by object type e.g. `/type/page`), `key` (filter by object key), `author` (filter by `/people/{user}`), `bot` (`true`/`false`), `limit` (max 1000), `offset` (max 10000). |
| `getRecentChangesByDate` | `restGet` | `/recentchanges/{year}/{month}/{day}.json` | Day-granularity path. Same `limit`/`offset` params. Year-only `/recentchanges/{YYYY}.json` and month-only `/recentchanges/{YYYY}/{MM}.json` granularities are deliberately omitted (the day form is the useful one; coarser forms are reachable via `type`/`key` filters). |
| `getRecentChangesByKind` | `restGet` | `/recentchanges/{kind}.json` | `{kind}` enum (documented): `add-cover`, `add-book`, `edit-book`, `merge-authors`, `update`, `revert`, `new-account`, `register`, `lists`. Same `limit`/`offset` params. The date+kind combo (`/recentchanges/{YYYY}/{MM}/{kind}.json`) is omitted as a rare variant. |

### Group E — Lists, read-only (7 ops)

| Op | Via | Path | Notes |
|----|-----|------|-------|
| `getUserLists` | `restGet` | `/people/{username}/lists.json` | A user's public lists. |
| `getListsForSeed` | `restGet` | `/{seed_type}/{seed_id}/lists.json` | **One documented endpoint** ("Get lists containing a seed") with a path-param enum, per the loc.gov `listItemsByFormat` precedent — not 4 separate ops. `seed_type` ∈ {`books`, `works`, `authors`, `subjects`}; `seed_id` is the OLID (for books/works/authors) or subject slug (for subjects). Enum values go in the param `description` (the schema has no `enum:` field). |
| `searchLists` | `restGet` | `/search/lists.json` | `q` required; `limit` (max 100 per docs), `offset`. |
| `getList` | `restGet` | `/people/{username}/lists/{list_id}.json` | List metadata. `{list_id}` e.g. `OL97L`. |
| `getListSeeds` | `restGet` | `/people/{username}/lists/{list_id}/seeds.json` | Seeds of a list. |
| `getListEditions` | `restGet` | `/people/{username}/lists/{list_id}/editions.json` | Params: `limit`, `offset`. |
| `getListSubjects` | `restGet` | `/people/{username}/lists/{list_id}/subjects.json` | Params: `limit`, `offset`. |

### Group F — Read API, single-request (1 op)

| Op | Via | Path | Notes |
|----|-----|------|-------|
| `getVolumeById` | `restGet` | `/api/volumes/brief/{id_type}/{id_value}.json` | Legacy Read API. `{id_type}` enum: `isbn`, `lccn`, `oclc`, `olid` (documented). Returns readable/borrowable volume info + bibliographic `records`. Multi-request form omitted (see out-of-scope). |

### Group G — Infogami `/query.json` (1 op, open param surface)

| Op | Via | Path | Notes |
|----|-----|------|-------|
| `queryThings` | `restGet` | `/query.json` | **Exercises the `passthrough` recipe flag.** Declares the known params (`type` required, `limit`, `offset`) and forwards any other caller-supplied keys onto the query string as-is — the Infogami flat-query form where the caller supplies type-specific properties (`isbn_10`, `authors`, `title`, `lc_classifications`, …) at query time. Without `passthrough`, those undeclared keys would be **silently dropped** by `buildQueryParams`; the flag opts the op into forwarding them so the agent's request reaches the wire intact. |

## Proposed `guide.md` YAML (per group)

> No top-level `pagination:` default is added — the Open Library endpoints
> use **two** page-param conventions (`start` for the search family,
> `offset` for editions/works/subjects), so each `paginate` op declares its
> own. The existing `searchBooks` op is left untouched.

### Group A

```yaml
  - name: searchAuthors
    via: paginate
    path: /search/authors.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: docs
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
    params:
      olid:
        description: Open Library Author ID, e.g. OL23919A (the {olid} path param).
        required: true

  - name: getWorksByAuthor
    via: paginate
    path: /authors/{olid}/works.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: entries
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
    params:
      olid:
        description: Open Library Author ID, e.g. OL23919A (the {olid} path param).
        required: true
      limit:
        description: Per-page count (default 50 per docs).
```

### Group B

```yaml
  - name: getWork
    via: restGet
    path: /works/{olid}.json
    accept: json
    params:
      olid:
        description: Open Library Work ID, e.g. OL15626917W (the {olid} path param).
        required: true

  - name: getEditionsByWork
    via: paginate
    path: /works/{olid}/editions.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: entries
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
    params:
      olid:
        description: Open Library Work ID, e.g. OL27258W (the {olid} path param).
        required: true
      limit:
        description: Per-page count.

  - name: getEdition
    via: restGet
    path: /books/{olid}.json
    accept: json
    params:
      olid:
        description: Open Library Edition ID, e.g. OL7170815M (the {olid} path param).
        required: true
```

### Group C

```yaml
  - name: getSubject
    via: paginate
    path: /subjects/{subject}.json
    accept: json
    pagination:
      style: offset-limit
      itemsPath: works
      pageParam: offset
      pageSizeParam: limit
      pageSize: 50
    params:
      subject:
        description: Subject slug, e.g. love or place:san_francisco (the {subject} path param).
        required: true
      details:
        description: "true to include related subjects, prominent publishers, prolific authors, and publishing_history."
      ebooks:
        description: "true to include only works that have an e-book."
      published_in:
        description: Published-year range filter, e.g. 1500-1600.
      limit:
        description: Per-page count.
```

### Group D

```yaml
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
      year:
        description: 4-digit year (the {year} path param).
        required: true
      month:
        description: 1- or 2-digit month (the {month} path param).
        required: true
      day:
        description: 1- or 2-digit day (the {day} path param).
        required: true
      limit:
        description: Max entries (default 100, max 1000).
      offset:
        description: Skip offset entries (max 10000).

  - name: getRecentChangesByKind
    via: restGet
    path: /recentchanges/{kind}.json
    accept: json
    params:
      kind:
        description: >
          Change kind (the {kind} path param). Documented values:
          add-cover, add-book, edit-book, merge-authors, update, revert,
          new-account, register, lists. More kinds may be added upstream.
        required: true
      limit:
        description: Max entries (default 100, max 1000).
      offset:
        description: Skip offset entries (max 10000).
```

### Group E

```yaml
  - name: getUserLists
    via: restGet
    path: /people/{username}/lists.json
    accept: json
    params:
      username:
        description: Open Library username (the {username} path param).
        required: true

  - name: getListsForSeed
    via: restGet
    path: /{seed_type}/{seed_id}/lists.json
    accept: json
    params:
      seed_type:
        description: >
          Seed type (the {seed_type} path param). One of: books, works,
          authors, subjects.
        required: true
      seed_id:
        description: >
          Seed identifier (the {seed_id} path param). An Open Library ID
          (e.g. OL1M / OL1W / OL1A) for books/works/authors, or a subject
          slug (e.g. place:san_francisco) for subjects.
        required: true

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
    params:
      username:
        description: Open Library username (the {username} path param).
        required: true
      list_id:
        description: List ID, e.g. OL97L (the {list_id} path param).
        required: true

  - name: getListSeeds
    via: restGet
    path: /people/{username}/lists/{list_id}/seeds.json
    accept: json
    params:
      username:
        description: Open Library username (the {username} path param).
        required: true
      list_id:
        description: List ID, e.g. OL97L (the {list_id} path param).
        required: true

  - name: getListEditions
    via: restGet
    path: /people/{username}/lists/{list_id}/editions.json
    accept: json
    params:
      username:
        description: Open Library username (the {username} path param).
        required: true
      list_id:
        description: List ID, e.g. OL97L (the {list_id} path param).
        required: true
      limit:
        description: Per-page count.
      offset:
        description: Skip offset entries.

  - name: getListSubjects
    via: restGet
    path: /people/{username}/lists/{list_id}/subjects.json
    accept: json
    params:
      username:
        description: Open Library username (the {username} path param).
        required: true
      list_id:
        description: List ID, e.g. OL97L (the {list_id} path param).
        required: true
      limit:
        description: Per-page count.
      offset:
        description: Skip offset entries.
```

### Group F

```yaml
  - name: getVolumeById
    via: restGet
    path: /api/volumes/brief/{id_type}/{id_value}.json
    accept: json
    params:
      id_type:
        description: >
          Identifier type (the {id_type} path param). One of: isbn, lccn,
          oclc, olid.
        required: true
      id_value:
        description: The identifier value (the {id_value} path param), e.g. 9780385533225 for an ISBN.
        required: true
```

### Group G

```yaml
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
```

> **How `passthrough` works here:** the caller supplies `type` plus any
> type-specific property keys as extra params (e.g.
> `isbn_10=0789312239`, `authors=/authors/OL1A`, `title=…`). The
> `buildQueryParams` loop handles the declared `type`/`limit`/`offset`
> (defaults + required-validation still fire), then a second loop forwards
> every **undeclared** caller key onto the query string as-is. Objects
> serialize as JSON (so the JSON-dict `query={…}` form also works if the
> caller prefers it). Path params are never forwarded. This is the
> general escape hatch for open-param-surface APIs (Infogami, CKAN,
> OAI-PMH) — opt in per operation; every other guide stays closed-by-default.

## Implementation phases

**Phase -1 — Cache specs locally:** SKIP. All docs are small, stateless
HTML pages already parsed inline; no PDFs or multi-page references to
cache. The "Work & Edition" page is gone (404) but its content is
recovered from the RESTful API + "More APIs" sections — nothing to cache.

**Phase 0 — Live shape probe:** DONE (2026-07-20, see above). Confirmed
`itemsPath` for the 4 paginated envelopes and the bare-array shape of
recentchanges. No further probes needed — the proposed YAML is grounded
in the probe results + the docs prose.

**Phase 1 — Group A (Author lookups):** 3 ops. Highest value: `searchAuthors`

+ `getAuthor` + `getWorksByAuthor` turn an author name into a full
bibliography. Add to `guide.md`, extend `endpoint-coverage.test.ts`.

**Phase 2 — Group B (Work & Edition lookups):** 3 ops. `getWork` +
`getEditionsByWork` + `getEdition` complete the work→edition hierarchy.

**Phase 3 — Group C (Subjects):** 1 op. `getSubject`.

**Phase 4 — Group D (Recent changes):** 3 ops. Lower priority but cheap
(all `restGet`).

**Phase 5 — Group E (Lists, read-only):** 7 ops. Niche but all trivial
`restGet` clones.

**Phase 6 — Group F (Read API):** 1 op. `getVolumeById` — the legacy
identifier→volume lookup.

**Phase 7 — Group G (Infogami `/query.json`, open param surface):** 1 op.
`queryThings` with `passthrough: true`. **Depends on the `passthrough`
recipe flag landing first** (type field + `buildQueryParams` forwarding +
parse validation). This is the first shipped op to exercise the flag and
serves as the live integration test for the open-param-surface escape
hatch; ship it last so the flag is stable before the guide depends on it.

## Testing

Follow the boe.es pattern — tests are **co-located with the guide**, in
`api-guides/openlibrary.org/`, not in the package `__tests__/` dir.

+ **`endpoint-coverage.test.ts`** (new file) — `HOST_INTEGRATION=1`-gated
  live coverage: parses the recipe, executes **every** defined operation
  against the live endpoint, asserts each response has the expected shape
  (status 200 + non-empty body / expected `itemsPath` for `paginate` ops /
  non-empty array for the `restGet` bare-array recentchanges ops).
  Skipped in bare CI. One assertion per operation (20 total: the existing
  `searchBooks` + 19 new, including `queryThings` with an extra
  type-specific key to prove `passthrough` reaches the wire).
+ **`helper.test.ts`** — NOT created. The expansion adds **zero** helper
  code (no `helper.ts` exists today and none is introduced), so no helper
  test is needed. The boe.es expansion likewise touched neither helper nor
  its test.

The package-level `__tests__/parse-api-guide.test.ts` regression (guide
parses with the new op count) is a nice-to-have; the co-located coverage
test already proves the guide parses, so it's not required.

Manual: run `api-guide` for `openlibrary.org` from a pi session, confirm
all 20 ops appear with correct param hints.

### Rate-limit note for the integration test

Open Library rate-limits unidentified traffic to **1 req/s** (3 req/s with
a `User-Agent` + email). The integration test should either pace its
requests or set an identifying `User-Agent` header to avoid 403s during
the 20-op live sweep. This is a test-authoring concern, not a guide change.

## Files touched

| File | Change |
|------|--------|
| `guide.md` | Add 19 operations across Phases 1–7 (Groups A–G). Leave existing `searchBooks` untouched. Phase 7 (`queryThings`) requires the `passthrough` recipe flag to have landed. |
| `helper.ts` | **Not touched** — no helper needed. |
| `endpoint-coverage.test.ts` | **New file** — live `HOST_INTEGRATION=1` coverage for all 20 ops (19 new + existing `searchBooks`). |
| `helper.test.ts` | **Not created** — no helper code added. |
| `spec/` | **Not created** — no specs cached (Phase -1 skipped). |

## Out of scope / deliberate omissions

+ **Write/mutation endpoints** (Lists create/delete/update/add-seed, Save
  `PUT`, Login `POST`) — out of scope per the audit rules.
+ **Covers API** — different host + binary image responses.
+ **Search inside** — dynamic archive.org data-node host, not a stable
  `openlibrary.org` endpoint.
+ **My Books** — patron reading logs, personal/auth-gated, not public
  bibliographic research data.
+ **Read API multi-request** — non-standard delimited path; single-request
  form covers it.
+ **Legacy JSON API** (`/api/things`, `/api/get`, `/api/versions`,
  `/api/search`) — deprecated; current RESTful API + resource lookups
  cover the same ground.
+ **`?m=history`** — documented but deferred (low value, not a schema
  limit): it IS expressible today via a fixed-value query param
  (`m: { default: "history" }` on a resource-lookup op); the only friction
  is modeling verbosity (one op per resource type). Deferred on value
  grounds — edit metadata is marginal for a research aide — not because
  the recipe can't model it. Revisit if a concrete need arises.
+ **`/query.json` JSON-dict form + `paginate` through the `query` object** —
  the flat form is now covered by Group G (`passthrough`). Two narrower
  limits remain documented but not built: (a) the JSON-dict `query={…}`
  param's *inner* shape is unvalidated (the schema has no `type` field on
  `QueryParamSpec` — the wire transport works, but the schema can't help
  or check it; for an LLM-driven tool the caller is the validator), and
  (b) `paginate` cannot drive paging state *inside* a structured param
  (the runner injects `pageParam` as a top-level query key). Both are
  rare for a rate-limited research aide; the caller composes the query and
  issues follow-up `restGet` calls. Revisit only if 3+ real APIs need it.
+ **Recent changes year-only / month-only / date+kind combos** — omitted
  as rare variants of the day-granularity and kind ops.
+ **No speculative pagination on `restGet` ops** — the recentchanges and
  lists endpoints support `limit`/`offset` but return bare arrays or
  single-page envelopes that the `paginate` runner can't drive (bare
  array: `itemsPath` is required and empty is rejected); the user pages
  manually via the documented `limit`/`offset` params. `paginate` is used
  only where a clean `itemsPath` is documented/probed (search/authors,
  editions, works-by-author, subjects).

## Implementation notes

Batch C rollout, implemented 2026-08-06. All **19** plan endpoints shipped
(all 7 families); 20 ops total (incl. existing `searchBooks`).

1. **Path params not re-declared in `params`.** The proposed YAML declared
   `olid`/`subject`/`username`/`list_id`/`seed_type`/`seed_id`/`year`/`month`/
   `day`/`kind`/`id_type`/`id_value` alongside the positional `{token}` in
   `path:`. The recipe parser **rejects** re-declaring path params
   ("omitted (path params are inferred from {token} in path)"). They are
   therefore inferred and documented in `guide.md` prose — the same deviation
   recorded for `datos.gob.es` in the rollout. No functional change; the wire
   requests are identical.
2. **`getListSubjects` live → HTTP 500 (upstream server bug, 2026-08-06).**
   The endpoint returns `500 Internal Server Error` for **every** real list
   probed (8+ distinct public lists, incl. large ones and the docs' own
   canonical example `george08/lists/OL97L`), not just one seed. Root cause
   confirmed against upstream source (`openlibrary/plugins/openlibrary/
   lists.py` → `List.get_subjects` in `openlibrary/core/lists/model.py`):
   the handler builds a **Solr facet query** from the list's own stored seeds
   and calls `get_solr().select(...)`; any Solr error surfaces as a 500.
   Our request only supplies the list key + optional `limit` (proven
   irrelevant: 500 with/without it, any UA/Accept) — the Solr query is
   derived entirely server-side from the list's seed data. Consistent with
   Open Library's ongoing 2026 H1 full Solr reindex (#11650). **Not a
   data-format problem in what we submit.** The op is wired correctly; the
   coverage assertion is kept strict so it goes green when upstream fixes
   it. Currently the one red live assertion (C2 best-effort: recorded,
   still shipped; bare CI is the binding gate). Re-probe later.
3. **`getListsForSeed` — only `works` seed 200s in probe.** `books`/`authors`/
   `subjects` seed types returned 500 for the probed OLIDs today (upstream).
   The live test uses a `works` seed (robust). The recipe itself declares the
   full `seed_type` enum per the docs; the other seed types may 500 upstream
   until fixed.
4. **`getVolumeById`** verified live with `id_type: isbn` (returns `records`).
5. **Live-test pacing.** Open Library rate-limits unidentified traffic to
   1 req/s; the pipeline sets no identifying UA, so `fetchOp` delays 400ms per
   request across the 20-op sweep to avoid 403s. `searchBooks` timed out once
   on the first burst (transient) — timeout raised to 30s; re-run green.
