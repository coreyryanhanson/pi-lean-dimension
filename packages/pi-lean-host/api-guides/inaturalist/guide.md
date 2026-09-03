---
kind: api
schemaVersion: 1
domains:
  - api.inaturalist.org
shortName: iNaturalist
icon: 🦋
apiHost: https://api.inaturalist.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
pagination:
  style: page
  itemsPath: results
  pageParam: page
  pageSizeParam: per_page
  pageSize: 100
  totalCountPath: total_results
operations:
  # The derived-id axis lives on this op only: an op-level pagination
  # override switches it from the guide's page style to the stable keyset
  # walk, mirroring the live-verified caritas recipe's structure.
  - name: listObservations
    via: paginate
    path: /v1/observations
    accept: json
    passthrough: true
    pagination:
      style: cursor
      itemsPath: results
      cursorParam: id_above
      cursorPath: "results[-1].id"
      totalCountPath: total_results
      pageSizeParam: per_page
      pageSize: 30
    params:
      order_by:
        description: >
          Sort field. Both sort defaults are load-bearing for the derived-id
          keyset walk — override the sort and the walk breaks.
        default: id
      order:
        description: >
          asc + id_above walks forward through history without overlap or
          gaps; desc + id_above double-counts.
        default: asc
      per_page:
        description: >
          Results per page (server default 30; API max 200 — observations
          embed full taxon and user objects, keep pages small).
      q:
        description: Free-text search over observation properties.
      taxon_name:
        description: >
          Taxon must have a scientific or common name matching this string.
---
# iNaturalist (axis guide) — derived-id negative-index cursor

Axis-guide fixture for the **derived-id negative-index cursor** axis:
iNaturalist's `/v1/observations` exposes **no cursor field anywhere in the
envelope** — the documented manual loop is "take the last observation's
integer `id` and pass it back as `id_above`". The cursor therefore comes
from `results[-1].id` (negative-index path into the items array) and rides
the wire as an **unquoted JSON integer** coerced to a string param.
Exhaustion is structural: the past-the-end request returns an empty
`results` array, which stops the walk via the pre-existing empty-page rule.
Also carries `exec-paginate` (cursor style) and `transport`, plus the
**op-level pagination override** (guide-level `page` style overridden to
`cursor` on the one op that needs it — same shape as the caritas recipe).

Response payloads are **real** (iNaturalist `/v1/observations`), captured
live and stripped leaner; the guide is exercised only against mocked
transport by the co-located test. There is **no live endpoint claim**
here — the full live-verified recipe lives in caritas.

## Operations

- **`listObservations`** (`paginate`, cursor) — walks `id_above` =
  previous page's last id (coerced integer); pages never overlap; the
  empty final `results` array terminates. The guide-level `page`-style
  pagination is overridden by the op block — the carrier for the
  op-override mechanism on this fixture.

## Shape notes

- The sort defaults (`order_by: id`, `order: asc`) are load-bearing for the
  keyset walk — a different sort makes `id_above` skip or double-count.
  The fixture pins the *derived-id + negative-index + numeric-coercion*
  axis, which is exactly what `advancePagination` sees.
- `total_results` is stable across pages (iNat reports the unfiltered
  total for the query), surfaced as `serverTotal`.
