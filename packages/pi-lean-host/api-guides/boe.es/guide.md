---
kind: api
schemaVersion: 0
domains:
  - boe.es
shortName: BOE
icon: 📜
apiHost: https://www.boe.es
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
operations:
  - name: searchDiary
    via: restGet
    path: /datosabiertos/api/boe/sumario/{fecha}
    accept: xml
    helper: true
    parse:
      format: xml
      charset: utf-8
  - name: listDiarios
    via: paginate
    path: /datosabiertos/api/boe/diarios
    accept: xml
    helper: true
    pagination:
      style: offset-limit
      itemsPath: diarios
      pageParam: offset
      pageSizeParam: limit
      pageSize: 2
    params:
      fecha:
        description: Start date (ISO YYYY-MM-DD, converted to aaaammdd by the helper).
---
# BOE (synthetic axis guide) — local-helper + XML + restGet/paginate

Synthetic coverage fixture for the `local-helper`, `xml-parsing`,
`exec-restGet`, `exec-paginate` (offset-limit) and `transport` axes. There is
**no live endpoint** — this guide is exercised only against mocked transport
by its co-located test.

Both operations declare `helper: true`; the co-located `helper.ts` is the
pre-call param transform (converts ISO dates to BOE's `aaaammdd` form). The
response shape is XML, so both ops also exercise XML→JSON parsing.

## Operations

- **`searchDiary`** (`restGet`) — a single day's gazette summary in XML.
  Path param `{fecha}`; the helper converts an ISO date to `aaaammdd`.
- **`listDiarios`** (`paginate`, offset-limit, XML) — pages the diary
  listings; `itemsPath: diarios` resolves on the stubbed XML body.
