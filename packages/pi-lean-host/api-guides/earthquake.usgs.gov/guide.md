---
kind: api
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
  pageSize: 50
gatherAllMax: 20000
verified: "2026-07-18"
docs: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
operations:
  # Group A — GeoJSON summary feeds (timeframe × significance). Identical shape.
  - name: getAllHour
    via: restGet
    path: /earthquakes/feed/v1.0/summary/all_hour.geojson
    accept: json
    transform: true
  - name: getSignificantHour
    via: restGet
    path: /earthquakes/feed/v1.0/summary/significant_hour.geojson
    accept: json
    transform: true
  - name: get4_5Hour
    via: restGet
    path: /earthquakes/feed/v1.0/summary/4.5_hour.geojson
    accept: json
    transform: true
  - name: get2_5Hour
    via: restGet
    path: /earthquakes/feed/v1.0/summary/2.5_hour.geojson
    accept: json
    transform: true
  - name: get1_0Hour
    via: restGet
    path: /earthquakes/feed/v1.0/summary/1.0_hour.geojson
    accept: json
    transform: true
  - name: getAllDay
    via: restGet
    path: /earthquakes/feed/v1.0/summary/all_day.geojson
    accept: json
    transform: true
  - name: getSignificantDay
    via: restGet
    path: /earthquakes/feed/v1.0/summary/significant_day.geojson
    accept: json
    transform: true
  - name: get4_5Day
    via: restGet
    path: /earthquakes/feed/v1.0/summary/4.5_day.geojson
    accept: json
    transform: true
  - name: get2_5Day
    via: restGet
    path: /earthquakes/feed/v1.0/summary/2.5_day.geojson
    accept: json
    transform: true
  - name: get1_0Day
    via: restGet
    path: /earthquakes/feed/v1.0/summary/1.0_day.geojson
    accept: json
    transform: true
  - name: getAllWeek
    via: restGet
    path: /earthquakes/feed/v1.0/summary/all_week.geojson
    accept: json
    transform: true
  - name: getSignificantWeek
    via: restGet
    path: /earthquakes/feed/v1.0/summary/significant_week.geojson
    accept: json
    transform: true
  - name: get4_5Week
    via: restGet
    path: /earthquakes/feed/v1.0/summary/4.5_week.geojson
    accept: json
    transform: true
  - name: get2_5Week
    via: restGet
    path: /earthquakes/feed/v1.0/summary/2.5_week.geojson
    accept: json
    transform: true
  - name: get1_0Week
    via: restGet
    path: /earthquakes/feed/v1.0/summary/1.0_week.geojson
    accept: json
    transform: true
  - name: getAllMonth
    via: restGet
    path: /earthquakes/feed/v1.0/summary/all_month.geojson
    accept: json
    transform: true
  - name: getSignificantMonth
    via: restGet
    path: /earthquakes/feed/v1.0/summary/significant_month.geojson
    accept: json
    transform: true
  - name: get4_5Month
    via: restGet
    path: /earthquakes/feed/v1.0/summary/4.5_month.geojson
    accept: json
    transform: true
  - name: get2_5Month
    via: restGet
    path: /earthquakes/feed/v1.0/summary/2.5_month.geojson
    accept: json
    transform: true
  - name: get1_0Month
    via: restGet
    path: /earthquakes/feed/v1.0/summary/1.0_month.geojson
    accept: json
    transform: true

  # Group B — GeoJSON detail for a single event.
  - name: getDetail
    via: restGet
    path: /earthquakes/feed/v1.0/detail/{eventId}.geojson
    accept: json

  # Group C — FDSN event query (offset-limit paginated, GeoJSON).
  - name: queryEvents
    via: paginate
    path: /fdsnws/event/1/query
    accept: json
    transform: true
    params:
      format:
        default: geojson
        description: Response format. Defaults to geojson; kml, csv, quakeml and text are also supported.
      offset:
        default: 1
        description: 1-based offset of the first result. USGS rejects offset=0, so the paginator seeds at 1.
      starttime:
        description: Inclusive lower bound of the query window, ISO 8601 (e.g. 2026-01-01 or 2026-01-01T00:00:00).
      endtime:
        description: Exclusive upper bound of the query window, ISO 8601 (e.g. 2026-01-31).
      minmagnitude:
        description: Include only events with magnitude at least this value.
      maxmagnitude:
        description: Include only events with magnitude at most this value.
      minlatitude:
        description: Southern latitude bound of the search box, in decimal degrees (-90..90).
      maxlatitude:
        description: Northern latitude bound of the search box, in decimal degrees (-90..90).
      minlongitude:
        description: Western longitude bound of the search box, in decimal degrees (-180..180).
      maxlongitude:
        description: Eastern longitude bound of the search box, in decimal degrees (-180..180).
      latitude:
        description: Latitude of the circle center (use with longitude + maxradiuskm).
      longitude:
        description: Longitude of the circle center (use with latitude + maxradiuskm).
      maxradiuskm:
        description: Radius of the search circle in km (use with latitude + longitude).
      eventtype:
        description: Event type filter (earthquake, quarry, explosion, etc.).
      eventid:
        description: Return a single event by identifier (equivalent to the detail feed, but through the query format).
      orderby:
        description: Sort order (time, time-asc, magnitude, magnitude-asc).
      catalog:
        description: Limit to a specific contributing catalog name.
      contributor:
        description: Limit to a specific contributor's events.
      reviewstatus:
        description: Review status filter (automatic, reviewed).

  # Group D — FDSN event count (same filters, returns a count).
  - name: countEvents
    via: restGet
    path: /fdsnws/event/1/count
    accept: json
    params:
      starttime:
        description: Inclusive lower bound of the query window, ISO 8601.
      endtime:
        description: Exclusive upper bound of the query window, ISO 8601.
      minmagnitude:
        description: Include only events with magnitude at least this value.
      maxmagnitude:
        description: Include only events with magnitude at most this value.
      minlatitude:
        description: Southern latitude bound of the search box.
      maxlatitude:
        description: Northern latitude bound of the search box.
      minlongitude:
        description: Western longitude bound of the search box.
      maxlongitude:
        description: Eastern longitude bound of the search box.
      latitude:
        description: Latitude of the circle center (use with longitude + maxradiuskm).
      longitude:
        description: Longitude of the circle center (use with latitude + maxradiuskm).
      maxradiuskm:
        description: Radius of the search circle in km.
      eventtype:
        description: Event type filter (earthquake, quarry, explosion, etc.).
      catalog:
        description: Limit to a specific contributing catalog name.
      contributor:
        description: Limit to a specific contributor's events.
      reviewstatus:
        description: Review status filter (automatic, reviewed).

  # Group E — FDSN service metadata.
  - name: listCatalogs
    via: restGet
    path: /fdsnws/event/1/catalogs
    accept: xml
    parse:
      format: xml
      charset: utf-8
  - name: listContributors
    via: restGet
    path: /fdsnws/event/1/contributors
    accept: xml
    parse:
      format: xml
      charset: utf-8
  - name: getApplicationJson
    via: restGet
    path: /fdsnws/event/1/application.json
    accept: json
  - name: getApplicationWadl
    via: restGet
    path: /fdsnws/event/1/application.wadl
    accept: xml
    parse:
      format: xml
      charset: utf-8
  - name: getVersion
    via: restGet
    path: /fdsnws/event/1/version
    accept: text/plain
    parse:
      format: text
      charset: utf-8
---
# USGS — Earthquake GeoJSON feed (G7: GeoJSON feature-collection)

The USGS earthquake service exposes earthquakes and event metadata with
**no auth**. US federal government data is public domain.

Three surfaces, all read-only:

- **GeoJSON Summary Feed** (`/earthquakes/feed/v1.0/summary/*.geojson`) —
  20 snapshot feeds. Each is a GeoJSON `FeatureCollection` keyed by
  significance (all / significant / 4.5+ / 2.5+ / 1.0+) × timeframe
  (hour / day / week / month). No params, no pagination — a snapshot at
  call time. Feeds for rare categories (notably `significant_*` and the
  high-magnitude hourly feeds like `4.5_hour`) can legitimately be empty.
- **GeoJSON Detail** (`/earthquakes/feed/v1.0/detail/{eventId}.geojson`) —
  a single `Feature` for one event (no `features` array wrapper).
- **FDSN Event API** (`/fdsnws/event/1/*`) — parameterized event `query`
  (offset-limit paginated), a `count`, and service metadata (`catalogs`,
  `contributors`, `application.json`, `application.wadl`, `version`).

## Operations

### `getAllHour` — all earthquakes in the last hour

`GET /earthquakes/feed/v1.0/summary/all_hour.geojson` returns a GeoJSON
`FeatureCollection`:

```json
{
  "type": "FeatureCollection",
  "metadata": { "count": 10, "title": "USGS All Earthquakes, Past Hour" },
  "features": [
    { "type": "Feature", "geometry": { "type": "Point", "coordinates": [-122.4, 38.8, 7.2] },
      "properties": { "mag": 1.2, "place": "…", "time": 1783400000130, "updated": … } }
  ]
}
```

**Post-response transform.** The 20 summary feeds declare `transform: true`.
The co-located `helper.ts` reshape+projects each feature so the agent sees a
lean, flat object instead of the GeoJSON shape:

- `geometry.coordinates` `[lon, lat, depth]` → flat `lon` / `lat` / `depth`
  scalar fields (the G7 positional-geometry stress).
- `properties` is projected to the fields an agent most needs (`mag`,
  `place`, `time`, `url`, `status`, `tsunami`, `magType`, `type`, `title`),
  dropping the noise (updated, tz, felt, cdi, mmi, alert, sig, net, code,
  ids, sources, types, nst, dmin, rms, gap, detail, …) — crucial for the
  big feeds (`all_month` can exceed 1000 events × a fat `properties` bag).

The `FeatureCollection` envelope is preserved. A throwing/odd-shaped
transform falls back to the raw body with a warning (graceful, no disable).
Example output for the feed above:

```json
{ "metadata": { "count": 10, "title": "USGS All Earthquakes, Past Hour" },
  "features": [ { "id": "…", "mag": 1.2, "place": "…", "time": 1783400000130,
    "url": "…", "status": "automatic", "tsunami": 0, "magType": "md",
    "type": "earthquake", "title": "M 1.2 …", "lon": -122.4, "lat": 38.8, "depth": 7.2 } ] }
```

### Summary feeds — `get{Significance}{Timeframe}`

The other 19 feeds (`getSignificantHour`, `get4_5Day`, `get2_5Week`,
`get1_0Month`, …) share `getAllHour`'s exact contract — same GeoJSON
`FeatureCollection`, no params. The name encodes the feed: significance in
`{all, significant, 4_5, 2_5, 1_0}`, timeframe in `{Hour, Day, Week, Month}`
(e.g. `get4_5Week` → `4.5_week.geojson`). Each is a single-page snapshot —
`via: restGet`, never paginated.

**Empty feeds.** The threshold and `significant` feeds reflect real global
seismicity at call time and can be empty (no `features` in a quiet hour for
`significant_hour` / `4.5_hour`), which is a valid result, not an error.

### `getDetail` — single event by ID

`GET /earthquakes/feed/v1.0/detail/{eventId}.geojson` returns a single
GeoJSON `Feature` (no `features` array). The `eventId` is the `id` field of
any summary-feed feature. The detail feature carries the same `properties`
as a summary feature (mag, place, time…) plus, for events that have them,
a `products` array with contributor deep-data (origin, moment-tensor,
shakemap, …). Not every event has `products`; rely on `type: "Feature"`
rather than the presence of `products`.

### `queryEvents` — parameterized event search (paginated)

`GET /fdsnws/event/1/query?format=geojson&…` searches the FDSN event
catalog. This is offset-limit paginated: the guide declares
`pagination: { style: offset-limit, itemsPath: features, pageParam: offset,
pageSizeParam: limit, pageSize: 50 }`. USGS uses **1-based `offset`** and
rejects `offset=0` (HTTP 400), so the recipe declares `params.offset.default:
1` and the paginator seeds from that. `gatherAll: true` walks pages up to
`gatherAllMax: 20000` (the service's own `maxAllowed` ceiling — a query
that would match more than 20 000 events fails, so bound it with `starttime`
/ `endtime` / magnitude filters).

`format` defaults to `geojson`; the caller may override to `kml`, `csv`,
`quakeml`, or `text`. All other params are optional ISO-8601 time, lat/lon
box or circle, magnitude, and catalog filters (see the recipe YAML for the
full list). `eventid` returns a single event in the query format.

`queryEvents` declares `transform: true`. Because it's `via: paginate`, the
hookpoint runs the same `helper.ts` transform **per item** — each `features[]`
feature is reshape+projected individually (same output shape as the summary
feeds). A throwing per-item transform routes that item to `failedItems`
(raw, untransformed) rather than dropping it.

### `countEvents` — count matching events

`GET /fdsnws/event/1/count` accepts the same time / location / magnitude /
catalog filters as `queryEvents` but returns a count, not a list. With no
`format` param the response is a **bare number** (the count). Passing
`format=geojson` switches it to a JSON object `{ "count": n,
"maxAllowed": 20000 }`, and when the matching set would exceed
`maxAllowed` that object also carries an `"error"` field explaining that
the search would fail — narrow the query. No pagination (a scalar).

### FDSN service metadata

- **`listCatalogs`** (`/catalogs`) and **`listContributors`**
  (`/contributors`) — the available catalog / contributor identifiers as
  **XML** (`<Catalogs><Catalog>…</Catalog>…</Catalogs>`), independent of the
  `Accept` header. Parsed via `parse: { format: xml }`.
- **`getApplicationJson`** (`/application.json`) — the FDSN parameter
  description as JSON (`catalogs[]`, `contributors[]`, `methods`, …).
- **`getApplicationWadl`** (`/application.wadl`) — the WADL interface
  description as XML. `parse: { format: xml }`.
- **`getVersion`** (`/version`) — the service version string (e.g. `2.7.0`)
  as plain text. `parse: { format: text }`.

## How G7 fires

`features[].geometry` is a **positional** `[lon, lat, depth]` array, not a flat
field; `properties` holds the tabular payload. A helper that assumes items are
flat objects with scalar fields breaks on `geometry.coordinates`. This is the
non-flat geo shape the G7 pool generalizes: `itemsPath: features` with
positional `geometry` is the stress — and the **post-response transform**
(above) is what defuses it, reshaping each feature flat before the agent sees
it.

`getDetail` is intentionally **not** gated on the transform: it's a single
`Feature` (no context pressure) whose `products` deep-data (origin,
moment-tensor, shakemap, …) is exactly what you fetch a detail for, so
projection would discard value rather than save context.

## Terms

US federal government — public domain. <https://earthquake.usgs.gov/fdsnws/event/1/>
