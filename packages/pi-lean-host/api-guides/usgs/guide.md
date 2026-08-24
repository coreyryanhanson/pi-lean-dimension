---
kind: api
schemaVersion: 0
domains:
  - earthquake.usgs.gov
shortName: USGS
icon: 🌍
apiHost: https://earthquake.usgs.gov
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
pagination:
  style: offset-limit
  itemsPath: features
  pageParam: offset
  pageSizeParam: limit
  pageSize: 2
operations:
  - name: getAllHour
    via: restGet
    path: /earthquakes/feed/v1.0/summary/all_hour.geojson
    accept: json
    transform: true
  - name: queryEvents
    via: paginate
    path: /fdsnws/event/1/query
    accept: json
    transform: true
    params:
      format:
        default: geojson
      starttime:
        description: Inclusive lower bound of the query window, ISO 8601.
      minmagnitude:
        description: Include only events with magnitude at least this value.
---
# USGS (synthetic axis guide) — transform-builtin on restGet AND paginate

Synthetic coverage fixture for the `transform-builtin` axis (both
`transform: true × via: restGet` and `transform: true × via: paginate`),
plus `exec-restGet`, `exec-paginate` (offset-limit), and `transport`. There
is **no live endpoint** — exercised only against mocked transport.

The co-located `helper.ts` exports a named `transform` that reshapes each
GeoJSON `Feature`'s positional `geometry.coordinates: [lon, lat, depth]`
into flat `lon`/`lat`/`depth` fields (the G7 non-flat geo shape).

## Operations

- **`getAllHour`** (`restGet`, `transform: true`) — a snapshot
  `FeatureCollection`; the transform reshapes the whole body's `features[]`.
- **`queryEvents`** (`paginate`, offset-limit, `transform: true`) — the
  transform runs per item; a throwing transform routes the item to
  `failedItems` (raw, never dropped).
