---
kind: api
schemaVersion: 0
domains:
  - musicbrainz.org
shortName: MusicBrainz
icon: 🎵
apiHost: https://musicbrainz.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-07-18"
docs: https://musicbrainz.org/doc/MusicBrainz_API
operations:
  - name: searchArtists
    via: paginate
    path: /ws/2/artist
    accept: json
    pagination:
      style: offset-limit
      itemsPath: artists
      pageParam: offset
      pageSizeParam: limit
      pageSize: 2
    params:
      query:
        description: Search query (required).
        required: true
      limit:
        description: Per-page count.
        default: 2
      fmt:
        description: >
          Response format chosen by **query param** (`fmt=json` or `fmt=xml`),
          not the Accept header. Defaulted to `json`.
        default: json
  - name: searchArtistsXml
    via: paginate
    path: /ws/2/artist
    accept: xml
    pagination:
      style: offset-limit
      itemsPath: metadata.artist-list.artist
      pageParam: offset
      pageSizeParam: limit
      pageSize: 2
    parse:
      format: xml
      charset: utf-8
    params:
      query:
        description: Search query (required).
        required: true
      limit:
        description: Per-page count.
        default: 2
      fmt:
        description: Response format via query param — `xml` for this op.
        default: xml
  - name: searchRecordings
    via: paginate
    path: /ws/2/recording
    accept: json
    pagination:
      style: offset-limit
      itemsPath: recordings
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchReleases
    via: paginate
    path: /ws/2/release
    accept: json
    pagination:
      style: offset-limit
      itemsPath: releases
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchReleaseGroups
    via: paginate
    path: /ws/2/release-group
    accept: json
    pagination:
      style: offset-limit
      itemsPath: release-groups
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchLabels
    via: paginate
    path: /ws/2/label
    accept: json
    pagination:
      style: offset-limit
      itemsPath: labels
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchWorks
    via: paginate
    path: /ws/2/work
    accept: json
    pagination:
      style: offset-limit
      itemsPath: works
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchAreas
    via: paginate
    path: /ws/2/area
    accept: json
    pagination:
      style: offset-limit
      itemsPath: areas
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchEvents
    via: paginate
    path: /ws/2/event
    accept: json
    pagination:
      style: offset-limit
      itemsPath: events
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchInstruments
    via: paginate
    path: /ws/2/instrument
    accept: json
    pagination:
      style: offset-limit
      itemsPath: instruments
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchPlaces
    via: paginate
    path: /ws/2/place
    accept: json
    pagination:
      style: offset-limit
      itemsPath: places
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchSeries
    via: paginate
    path: /ws/2/series
    accept: json
    pagination:
      style: offset-limit
      itemsPath: series
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: searchUrls
    via: paginate
    path: /ws/2/url
    accept: json
    pagination:
      style: offset-limit
      itemsPath: urls
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      query:
        description: Lucene search query. Searchable fields vary by entity.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getArtist
    via: restGet
    path: /ws/2/artist/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (aliases, recordings, releases, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getRecording
    via: restGet
    path: /ws/2/recording/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (aliases, artist-rels, releases, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getRelease
    via: restGet
    path: /ws/2/release/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (recordings, labels, discids, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getReleaseGroup
    via: restGet
    path: /ws/2/release-group/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (releases, artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getLabel
    via: restGet
    path: /ws/2/label/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (releases, aliases, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getWork
    via: restGet
    path: /ws/2/work/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getArea
    via: restGet
    path: /ws/2/area/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (aliases, artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getEvent
    via: restGet
    path: /ws/2/event/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getInstrument
    via: restGet
    path: /ws/2/instrument/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getPlace
    via: restGet
    path: /ws/2/place/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (aliases, artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getSeries
    via: restGet
    path: /ws/2/series/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (releases, artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: getUrl
    via: restGet
    path: /ws/2/url/{mbid}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (artist-rels, etc.).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: browseReleasesByArtist
    via: paginate
    path: /ws/2/release
    accept: json
    pagination:
      style: offset-limit
      itemsPath: releases
      totalCountPath: release-count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      artist:
        description: MBID of the artist whose releases to list.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: browseRecordingsByRelease
    via: paginate
    path: /ws/2/recording
    accept: json
    pagination:
      style: offset-limit
      itemsPath: recordings
      totalCountPath: recording-count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      release:
        description: MBID of the release whose track recordings to list.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: browseReleaseGroupsByArtist
    via: paginate
    path: /ws/2/release-group
    accept: json
    pagination:
      style: offset-limit
      itemsPath: release-groups
      totalCountPath: release-group-count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      artist:
        description: MBID of the artist whose release-groups to list.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: browseReleasesByLabel
    via: paginate
    path: /ws/2/release
    accept: json
    pagination:
      style: offset-limit
      itemsPath: releases
      totalCountPath: release-count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      label:
        description: MBID of the label whose releases to list.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: browseRecordingsByArtist
    via: paginate
    path: /ws/2/recording
    accept: json
    pagination:
      style: offset-limit
      itemsPath: recordings
      totalCountPath: recording-count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      artist:
        description: MBID of the artist whose recordings to list.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: browseWorksByArtist
    via: paginate
    path: /ws/2/work
    accept: json
    pagination:
      style: offset-limit
      itemsPath: works
      totalCountPath: work-count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      artist:
        description: MBID of the artist whose composed works to list.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: browseReleasesByCollection
    via: paginate
    path: /ws/2/release
    accept: json
    pagination:
      style: offset-limit
      itemsPath: releases
      totalCountPath: release-count
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      collection:
        description: MBID of a public collection whose releases to list.
        required: true
      limit:
        description: Per-page count (max 100).
        default: 25
      inc:
        description: Space-separated subqueries.
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: lookupDiscId
    via: restGet
    path: /ws/2/discid/{discid}
    accept: json
    params:
      toc:
        description: TOC string for fuzzy lookup when an exact discid is not found.
      inc:
        description: Space-separated subqueries (same as release lookup).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: lookupIsrc
    via: restGet
    path: /ws/2/isrc/{isrc}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (same as recording lookup).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: lookupIswc
    via: restGet
    path: /ws/2/iswc/{iswc}
    accept: json
    params:
      inc:
        description: Space-separated subqueries (same as work lookup).
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: lookupUrlByResource
    via: restGet
    path: /ws/2/url
    accept: json
    params:
      resource:
        description: URL to look up. Sent URL-encoded in the `resource` query param.
        required: true
      fmt:
        description: Response format via query param — `json` or `xml`.
        default: json
  - name: listAllGenres
    via: paginate
    path: /ws/2/genre/all
    accept: json
    pagination:
      style: offset-limit
      itemsPath: genres
      pageParam: offset
      pageSizeParam: limit
      pageSize: 25
    params:
      limit:
        description: Per-page count (max 100).
        default: 25
      fmt:
        description: Response format via query param — `json`, `xml`, or `txt`.
        default: json
---
# MusicBrainz — Artist search + curated metadata endpoints

MusicBrainz exposes open music metadata with **no auth** (1 req/sec rate limit,
User-Agent required). MusicBrainz data is **CC0** (public domain).

## Operations

The base is **Artist search** (G5: JSON/XML artist search). The rollout added a
**curated subset** of read-only metadata endpoints across the 13 core entities:
11 searches, 12 lookups, 7 browses, 3 non-MBID lookups (discid / isrc / iswc),
URL-by-resource, and the genre list. All JSON ops accept `fmt=json` (default)
and return the entity object bare for lookups or `{<plural>: [...]}` for
search/browse.

### `searchArtists` / `searchArtistsXml` — JSON / XML artist search

`GET /ws/2/artist?query=…&limit=2&fmt=json` returns
`{created, count, offset, artists[]}` (UUID `id`s). Format is selected by the
**`fmt` query param**, not the `Accept` header.

### Search family — `search<Entity>`

`GET /ws/2/<entity>?query=…&fmt=json` → `{count, offset, <plural>: [...]}`.
Identical shape across entities; `itemsPath` is `<entity>s` (dash for
`release-groups`). Paginated via offset-limit.

### Lookup family — `get<Entity>`

`GET /ws/2/<entity>/{mbid}?fmt=json` → the bare entity object (top-level has
`id`; JSON is **not** wrapped under an entity-named key — XML wraps under
`<entity>`). The `{mbid}` path param is inferred from the path token.

### Browse family — `browse<Result>By<Linked>`

`GET /ws/2/<result>?<linked>=<mbid>&fmt=json` → `{<plural>-count, <plural>,
[...]}`. Paginated via offset-limit.

### Non-MBID lookups — `lookupDiscId` / `lookupIsrc` / `lookupIswc`

`GET /ws/2/discid/{discid}?fmt=json` → `{releases: [...]}`;
`GET /ws/2/isrc/{isrc}?fmt=json` → `{recordings: [...]}`;
`GET /ws/2/iswc/{iswc}?fmt=json` → `{works: [...]}`. The path token
(`{discid}` / `{isrc}` / `{iswc}`) is inferred from the path.

### `lookupUrlByResource` — URL text → URL entity

`GET /ws/2/url?resource=<url>&fmt=json` → a single URL entity `{id, resource}`
(when one resource matches) or a `url-list`. The `resource` value is
URL-encoded by the transport.

### `listAllGenres` — all genres

`GET /ws/2/genre/all?fmt=json` → `{genres: [...]}` (also `genre-count`).
`fmt=txt` returns plain-text names (no pagination).

## How G5 fires

`responseShape.format` (the *response* shape) must not be conflated with the
*request's* `fmt` query param. The JSON op declares `format: json`; the XML op
declares `format: xml` — both hit the same path with a different `fmt` param.
A helper that assumes `Accept` drives the format breaks here.

## ⚠ Schema gaps (escape-valve evidence)

- **G12 (User-Agent requirement):** anonymous clients (no `User-Agent`
  header) get **HTTP 403** per MusicBrainz rate-limit policy. The v1 helper
  contract transforms only **params**, not headers, so the recipe cannot set
  the UA — same transport-header escape-valve class as Wikipedia's
  `Api-User-Agent` and resources.data.gov's `X-Api-Key`.
- **G11 (rate-limit headers):** `X-RateLimit-Limit/Remaining/Reset` are
  documented; the transport does not surface them. Transport-policy escape-valve
  candidate.

## Terms

MusicBrainz data is CC0 (public domain). API etiquette:
<https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting>
