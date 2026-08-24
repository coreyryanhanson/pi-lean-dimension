---
kind: api
schemaVersion: 0
organization: archive.org
description: Synthetic axis guide — transform-builtin (restGet) on the wayback CDX surface.
domains:
  - archive.org
shortName: Wayback Availability
icon: 📼
apiHost: https://archive.org
auth:
  kind: none
responseShape:
  format: text
  charset: utf-8
operations:
  - name: getClosestSnapshot
    via: restGet
    path: /wayback/available
    accept: text/plain
    transform: true
    parse:
      format: text
      charset: utf-8
    params:
      url:
        required: true
        description: The URL to check for an archived snapshot.
---
# Wayback Availability (synthetic axis guide) — transform-builtin (restGet)

Synthetic coverage fixture for the `transform-builtin` axis via a
`restGet × transform: true` op on a `text` response body, plus
`exec-restGet`, `transport`, and the `archive.org` `multi-recipe-domains`
pair. There is **no live endpoint** — exercised only against mocked
transport.

Claims `domains: [archive.org]`, sharing it with the `archive.org` axis
guide. The co-located `helper.ts` exports a named `transform` that reshapes
the text/plain body; a throwing transform keeps the raw body with a
warning (no disable).

## Operations

- **`getClosestSnapshot`** (`restGet`, `transform: true`, `text`) — the
  raw text body passes through a post-response transform.
