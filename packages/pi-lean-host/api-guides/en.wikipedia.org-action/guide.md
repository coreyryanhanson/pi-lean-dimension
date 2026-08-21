---
kind: api
schemaVersion: 0
organization: wikimedia.org
description: Synthetic axis guide — tokenBag pagination + transform (paginate).
domains:
  - wikipedia.org
shortName: Wikimedia Action
icon: 🛠️
apiHost: https://en.wikipedia.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: listRecentChanges
    via: paginate
    path: /w/api.php
    accept: json
    transform: true
    pagination:
      style: tokenBag
      itemsPath: query.recentchanges
      continuationParams:
        - continue.rccontinue
        - continue.continue
    params:
      action:
        default: query
      list:
        default: recentchanges
      rclimit:
        default: 2
      format:
        default: json
  - name: queryPages
    via: restGet
    path: /w/api.php
    accept: json
    requiresAnyOf: [titles, pageids, revids]
    params:
      action:
        default: query
      format:
        default: json
      titles:
        description: Page titles to query — at least one of titles, pageids, revids.
        verifyValue: "Albert Einstein"
      pageids:
        description: Page IDs to query — at least one of titles, pageids, revids.
      revids:
        description: Revision IDs to query — at least one of titles, pageids, revids.
---
# Wikimedia Action (synthetic axis guide) — tokenBag + transform (paginate)

Synthetic coverage fixture for the `tokenBag` pagination style (the rarest
style, previously exercised only by the real `en.wikipedia.org-action`
guide) paired with `transform: true × via: paginate` to reinforce
`transform-builtin`. Plus `exec-paginate` and `transport`. There is **no
live endpoint** — exercised only against mocked transport.

## Operations

- **`listRecentChanges`** (`paginate`, `tokenBag`, `transform: true`) —
  merges the continuation keys (`continue.rccontinue`,
  `continue.continue`) from each page into the next request's query params.
  A throwing per-item transform routes that item to `failedItems` (raw).
- **`queryPages`** (`restGet`, `requiresAnyOf`) — accepts pages by `titles`
  **OR** `pageids` **OR** `revids` (MediaWiki `action=query`): three
  interchangeable single params, the clean v1 shape for `requiresAnyOf`.
  Soft-enforced by the real API (empty spec → empty batch, not a 400), but
  as a synthetic fixture the shape fit is what matters — it exercises the
  field end-to-end (parser → render → verify → `buildQueryParams`). `titles`
  carries a `verifyValue` so `/api verify` can run the op without a
  `verify.json` sidecar.
