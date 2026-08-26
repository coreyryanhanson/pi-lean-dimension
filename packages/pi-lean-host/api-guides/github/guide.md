---
kind: api
schemaVersion: 1
domains:
  - github.com
shortName: GitHub
icon: 🐙
apiHost: https://api.github.com
auth:
  kind: static-key
  secretRefs:
    Authorization:
      secret: api_key
      optional: true
responseShape:
  format: json
  charset: utf-8
operations:
  - name: searchRepos
    via: paginate
    path: /search/repositories
    accept: json
    pagination:
      style: page
      itemsPath: items
      totalCountPath: total_count
      pageParam: page
      pageSizeParam: per_page
      pageSize: 2
    params:
      q:
        description: Search query (required).
        required: true
      page:
        description: 1-based page number.
      per_page:
        description: Per-page count.
        default: 2
  - name: getRepo
    via: restGet
    path: /repos/{owner}/{repo}
    accept: json
---
# GitHub API (synthetic axis guide) — static-key auth + page pagination

Synthetic coverage fixture for the `static-key-auth` axis (header-secret
injection + fail-closed-before-request) and the `page` pagination style,
plus `exec-restGet`, `exec-paginate`, and `transport`. There is **no live
endpoint** — exercised only against mocked transport.

`auth.kind: static-key` with `secretRefs: { Authorization: { secret: api_key, optional: true } }`
— a missing key proceeds unauthenticated; the request is only ever
fail-closed when a *required* secret is absent (not exercised here — this
guide marks the key optional to keep the fixture runnable without
provisioning).

## Operations

- **`searchRepos`** (`paginate`, `page` style) — `/search/repositories`
  with `itemsPath: items`. When a key is provisioned, the transport's
  captured headers must include `Authorization`.
- **`getRepo`** (`restGet`) — a single repo by `{owner}/{repo}`.
