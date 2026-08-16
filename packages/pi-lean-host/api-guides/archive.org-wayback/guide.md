---
kind: api
schemaVersion: 0
organization: archive.org
description: Closest archived snapshot for a URL (Wayback Availability JSON API).
domains:
  - archive.org
shortName: Wayback Availability
icon: 📼
apiHost: https://archive.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-08-08"
docs: https://archive.org/help/wayback_api.php
operations:
  - name: getClosestSnapshot
    via: restGet
    path: /wayback/available
    accept: json
    params:
      url:
        required: true
        description: The URL to check for an archived snapshot (host form, e.g. `example.com`). The most recent capture is returned when `timestamp` is omitted.
      timestamp:
        description: Optional 1-14 digit timestamp (yyyyMMddhhmmss) to find the snapshot closest to, e.g. 20060101.
# `callback` (JSONP wrapper) is deliberately absent — it exists for
# browser-side embeds, not for an agent JSON consumer. One op is the whole
# surface: the Availability API is a single `closest` lookup.
---
# Wayback Machine — Availability API

The Internet Archive Availability JSON API answers one question: **is this
URL archived, and what's the closest snapshot?** A single read-only
endpoint, no auth, on the same host as Item Metadata.

> **Multi-recipe note.** This guide shares `domains: [archive.org]` with the
> Item Metadata guide (`archive.org/`). Both are reached via
> `api-fetch({domain: "archive.org", …})`; operations resolve by name across
> the two guides — `getClosestSnapshot` lands here, metadata ops land in the
> other guide. `api-guide({domain: "archive.org"})` shows the disambiguation
> menu for both.

## Operations

### `getClosestSnapshot` — closest archived snapshot

`GET /wayback/available?url=…` returns the closest capture to the given URL
(and optional `timestamp`):

```json
{
  "archived_snapshots": {
    "closest": {
      "status": "200",
      "available": true,
      "url": "http://web.archive.org/web/20060101064348/http://www.example.com:80/",
      "timestamp": "20060101064348"
    }
  }
}
```

When the URL has no archive (or isn't currently accessible), the response is
`{"archived_snapshots": {}}` — `closest` is absent, and `available` never
appears. Check for the `closest` key before reading `available`.

`url` is required and matches in host form (`example.com`). `timestamp` is an
optional 1-to-14-digit time (`YYYYMMDDhhmmss`); without it, the most recent
snapshot is returned. The returned `url` is the Wayback snapshot link — to
fetch the archived page itself, navigate to it with the browser tools.

## Terms

Internet Archive Wayback Machine; access unrestricted for reasonable volume.
<https://archive.org/help/wayback_api.php>
