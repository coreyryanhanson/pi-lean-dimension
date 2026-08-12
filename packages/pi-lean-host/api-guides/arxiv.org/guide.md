---
kind: api
domains:
  - arxiv.org
  - export.arxiv.org
shortName: arXiv
icon: 📄
apiHost: https://export.arxiv.org
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
verified: "2026-08-10"
docs: https://info.arxiv.org/help/api/user-manual.html
operations:
  - name: search
    via: paginate
    path: /api/query
    accept: xml
    gatherAllMax: 1000
    pagination:
      style: offset-limit
      itemsPath: feed.entry
      pageParam: start
      pageSizeParam: max_results
      pageSize: 10
      totalCountPath: feed.totalResults
    params:
      search_query:
        description: >
          arXiv query DSL. Field prefixes: `all:` `ti:` `au:` `abs:` `co:`
          `jr:` `cat:` `rn:`; boolean AND/OR/ANDNOT; one date filter
          `submittedDate:[YYYYMMDDTTTT+TO+YYYYMMDDTTTT]` (GMT).
        required: true
      max_results:
        description: Results per page (max 30000 in slices ≤ 2000; keep small — large sets are slow).
        default: 10
      start:
        description: 0-based index of first result (paging).
        default: 0
      sortBy:
        description: relevance | lastUpdatedDate | submittedDate.
        default: relevance
      sortOrder:
        description: ascending | descending.

  - name: fetchByIds
    via: paginate
    path: /api/query
    accept: xml
    gatherAllMax: 1000
    pagination:
      style: offset-limit
      itemsPath: feed.entry
      pageParam: start
      pageSizeParam: max_results
      pageSize: 25
      totalCountPath: feed.totalResults
    params:
      id_list:
        description: Comma-delimited arXiv IDs (e.g. `cond-mat/0011267,0710.5765v1`). `vN` selects a specific version.
        required: true
      max_results:
        description: Results per page.
        default: 25

  - name: searchRecent
    via: paginate
    path: /api/query
    accept: xml
    gatherAllMax: 1000
    pagination:
      style: offset-limit
      itemsPath: feed.entry
      pageParam: start
      pageSizeParam: max_results
      pageSize: 10
      totalCountPath: feed.totalResults
    params:
      search_query:
        description: >-
          arXiv query DSL scoped to a category for "recent papers": pass
          `cat:<category>` (e.g. `cat:cs.AI`). Combined with the default
          sort below this lists the newest submissions in a subject area.
        required: true
      max_results:
        description: Results per page.
        default: 10
      start:
        description: 0-based index of first result (paging).
        default: 0
      sortBy:
        description: relevance | lastUpdatedDate | submittedDate. Defaults to submittedDate for recency.
        default: submittedDate
      sortOrder:
        description: ascending | descending. Defaults to descending for recency.
        default: descending
---
# arXiv — e-Print Archive API

The arXiv API (`export.arxiv.org/api/query`) provides read-only access to the
arXiv e-print archive's metadata (preprints, abstracts, authors, categories,
journal references). Fully unauthenticated and read-only. The API documents
exactly **one** method, `query` (GET or POST); the three operations here are
usage modes of that single endpoint the agent picks by intent.

> **HTTPS only (live-verified):** the docs still say `http://`, but
> `http://export.arxiv.org/…` returns an **empty body**; use the
> `https://` host (already set as `apiHost`).

## Operations

### `search` — Search arXiv by query

Returns a paginated Atom feed of results matching an arXiv query DSL string.

**`search_query` DSL** (manual §5.1): field prefixes are `all:` (all fields),
`ti:` (title), `au:` (author), `abs:` (abstract), `co:` (comment), `jr:`
(journal ref), `cat:` (subject category), `rn:` (report number). Join with
boolean `AND` / `OR` / `ANDNOT` and parens; one date-range filter
`submittedDate:[YYYYMMDDTTTT+TO+YYYYMMDDTTTT]` (GMT). Examples:
`all:electron AND cat:cond-mat.mes-hall`, `ti:quantum ANDNOT au:smith`.

**Pagination:** offset-limit via `start` (0-indexed) / `max_results`
(default 10 per page). The feed's `totalResults` (surfaced as
`serverTotal`) is the authoritative result count — **page explicitly by
advancing `start` up to `serverTotal`** rather than relying on an
unbounded `gatherAll`. arXiv does **not** return an empty page at the
sharp end of a result set: a `start` past the last valid index yields an
error — a single error `<entry>` (`id` = `https://arxiv.org/api/errors`)
at some offsets, an HTTP 500 at others — never a clean `[]`. A
`gatherAll` walk past the end therefore doesn't terminate cleanly (it
collects error sentinels or throws). The op caps `gatherAllMax` at 1000
to bound such walks, but the agent should prefer explicit `start`-based
pagination up to `serverTotal`.

### `fetchByIds` — Fetch specific papers by arXiv ID

Returns entries for the exact arXiv IDs in `id_list` (comma-delimited,
optionally with `vN` version suffixes). Item count equals the number of
valid IDs found (bogus IDs are silently dropped). Also supports paging a
large `id_list` via `start`/`max_results` (default 25/page).

### `searchRecent` — Recent papers in a category

Same endpoint as `search`, but with the sort pre-set to recency: pass
`search_query` = `cat:<category>` (e.g. `cat:cs.AI`) and the operation's
default `sortBy: submittedDate` + `sortOrder: descending` lists the newest
submissions in that subject area first.

## Response fields

Every response is an Atom `<feed>`. The `itemsPath` is `feed.entry` — each
entry carries:

- `id` — the paper's abstract URL (`https://arxiv.org/abs/…`).
- `title`, `summary` (the abstract), `published`, `updated`.
- `author` → `name` (one or more authors).
- `category` → `term` / `scheme` (one or more subject categories).
- `link` — `rel=alternate` (abstract page), `rel=related title=pdf`
  (PDF), `title=doi` (DOI).
- arXiv extension fields (unprefixed after namespaced-XML handling):
  `primary_category` (single primary category), `comment`, `journal_ref`,
  `doi`; `affiliation` appears inside each `author`.

Feed-level: `totalResults`/`startIndex`/`itemsPerPage` (the OpenSearch
totals), and `updated` (the refresh timestamp — search results are stable
until the next arXiv ingestion cycle, so cache results rather than
re-fetching).

## Rate / usage notes

- No API key required. Be polite: keep `max_results` small and space
  requests out (the manual suggests ~3s between calls and caching results).
- Large result sets are slow and can exceed 15MB — the manual explicitly
  discourages them. Prefer narrow queries and small pages.
