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
