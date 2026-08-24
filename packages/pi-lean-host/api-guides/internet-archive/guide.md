---
kind: api
schemaVersion: 0
organization: archive.org
description: Synthetic axis guide — nextLink + cursor pagination over one domain.
domains:
  - archive.org
shortName: Internet Archive
icon: 🏛️
apiHost: https://archive.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
operations:
  - name: listSnapshots
    via: paginate
    path: /wayback/cdx
    accept: json
    pagination:
      style: nextLink
      itemsPath: snapshots
      nextLinkPath: pagination.next
    params:
      url:
        required: true
  - name: searchItems
    via: paginate
    path: /advancedsearch.php
    accept: json
    pagination:
      style: cursor
      itemsPath: response.docs
      cursorParam: cursor
      cursorPath: cursor
    params:
      q:
        required: true
---
# Internet Archive (synthetic axis guide) — nextLink + cursor + ssrf-guard

Synthetic coverage fixture for the `ssrf-guard` axis (via the `nextLink`
paginate op — the one place a URL comes from the remote server) and the
`nextLink` + `cursor` pagination styles, plus `exec-paginate`, `exec-restGet`,
and `transport`. There is **no live endpoint** — exercised only against
mocked transport. nextLink/cursor behavior itself is proved in
`__tests__/axis-units.test.ts` (axes A/C); this guide carries the ops so the
`ssrf-guard` axis and the `archive.org` multi-recipe pair stay in the kept
union.

Claims `domains: [archive.org]`, sharing it with the `wayback-availability`
axis guide — together they exercise `multi-recipe-domains` dispatch (see the
co-located test).

## Operations

- **`listSnapshots`** (`paginate`, `nextLink`) — the ssrf-guard proof: a
  server-supplied `pagination.next` pointing at a loopback/RFC1918 host is
  blocked.
- **`searchItems`** (`paginate`, `cursor`) — Solr-style search advancing via
  a server-supplied `cursor` value.
