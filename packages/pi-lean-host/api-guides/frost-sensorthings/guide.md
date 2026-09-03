---
kind: api
schemaVersion: 1
domains:
  - airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de
shortName: FROST SensorThings
icon: 🌍
apiHost: https://airquality-frost.k8s.ilt-dmz.iosb.fraunhofer.de/v1.1
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
pagination:
  style: nextLink
  itemsPath: value
  nextLinkPath: "['@iot.nextLink']"
  totalCountPath: "['@iot.count']"
operations:
  - name: listThings
    via: paginate
    path: /Things
    accept: json
    passthrough: true
    params:
      $top:
        description: Page size (SensorThings `$top`). Server default is 20.
      $count:
        default: true
        description: >
          Include the server-reported total (`@iot.count`) in the response —
          surfaced as `serverTotal`.
---
# FROST SensorThings (axis guide) — quoted dotted keys + nextLink

Axis-guide fixture for the **dotted-key** axis: OData v4 pagination lives in
literal top-level keys whose dots are part of the key name (`@iot.nextLink`,
`@iot.count`), so every path goes through the quoted-bracket form `['…']`.
Also carries `exec-paginate` (nextLink style — the sole server-supplied-URL
SSRF-guard path) and `transport`.

Response payloads are **real** (EEA air-quality instance, Fraunhofer FROST
Server v1.1), captured live and stripped leaner; the guide is exercised only
against mocked transport by the co-located test. There is **no live endpoint
claim** here — the full live-verified recipe lives in caritas.

## Operations

- **`listThings`** (`paginate`, nextLink) — walks `['@iot.nextLink']` past
  page 1; `['@iot.count']` surfaces `serverTotal`. OData system query
  options (`$top`, `$filter`, …) flow through via `passthrough: true`.
