---
kind: api
schemaVersion: 1
domains:
  - wikidata.org
shortName: Wikidata Search
icon: 🔣
apiHost: https://www.wikidata.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: searchEntities
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: cursor
      itemsPath: search
      cursorParam: continue
      cursorPath: search-continue
    params:
      action:
        description: Wikidata action module — entity search (wbsearchentities).
        default: wbsearchentities
      search:
        description: Query matched against entity labels and aliases (required).
        required: true
      language:
        description: Language code of the search query/surfaces (required).
        default: en
      limit:
        description: Max results per page (server cap 50).
        default: 20
      format:
        description: Response format (json).
        default: json
---
# Wikidata Search (axis guide) — dedicated-field numeric cursor

Axis-guide fixture for the **numeric-cursor** axis, grounded in the caritas
`wikidata` recipe's `searchEntities` op (same domain, path, and params) with
**only the pagination treatment changed**: the caritas guide formulates
`wbsearchentities` as `offset-limit` (framework computes `continue` as
prev + pageSize, body field unread); this fixture formulates the same
endpoint as `cursor`, reading the server-supplied top-level numeric field
`search-continue` and echoing it back as `continue` — exercising the
Sprint-1 numeric-coercion code path (JSON-integer continuation field →
string wire param). The field is **absent** on the terminal page (and on
zero-hit searches), which stops the walk cleanly. Also carries
`exec-paginate` (cursor style) and `transport`.

Response payloads are **real** (Wikidata `wbsearchentities`, CC0 data),
captured live at `limit=3` and stripped leaner; the guide is exercised only
against mocked transport by the co-located test. There is **no live
endpoint claim** here — the full live recipe lives in caritas.

## Operations

- **`searchEntities`** (`paginate`, cursor) — echoes `search-continue`
  from each page into the next request's `continue` param; a page without
  the field (fewer than `limit` hits, or none) terminates. Pages never
  overlap (verified live: offset 0–2 → 3–5 → terminal).

## Shape notes

- The cursor is a **stable offset** (relevance-ranked search), not a keyset
  walk — the fixture pins the *numeric continuation field + coercion* axis,
  which is exactly what `advancePagination` sees (field provenance is
  invisible to it). The wire behavior is identical to the caritas guide's
  `offset-limit` formulation; only the client strategy differs.
- Wikimedia asks for a descriptive User-Agent (policy, not enforcement).
