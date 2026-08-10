---
kind: api
organization: archive.org
description: Item metadata records and full-corpus Solr search on archive.org.
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
verified: "2026-07-18"
docs: https://archive.org/developers/metadata.html
operations:
  - name: getItemMetadata
    via: restGet
    path: /metadata/{identifier}
    accept: json

  - name: getItemField
    via: restGet
    path: /metadata/{identifier}/{field}
    accept: json

  - name: getItemFilesSlice
    via: restGet
    path: /metadata/{identifier}/files
    accept: json
    params:
      start:
        description: Index to start the files array slice. Default 0.
        default: 0
      count:
        description: Number of files to return in the slice.

  - name: searchItems
    via: paginate
    path: /advancedsearch.php
    accept: json
    pagination:
      style: page
      itemsPath: response.docs
      totalCountPath: response.numFound
      pageParam: page
      pageSizeParam: rows
      pageSize: 50
    params:
      q:
        description: Solr query string. Supports field queries like `collection:opensource`.
      fl:
        description: "Comma-separated field list. Common fields: identifier, title, description, creator, date, mediatype, collection, downloads."
      output:
        description: Response format. Must be `json` to get the Solr JSON envelope (the API returns an HTML page otherwise).
        default: json
      sort:
        description: Sort specification, e.g. `downloads desc`, `date asc`.
---
# Internet Archive — Item Metadata API (G10: non-list single resource)

The Internet Archive metadata API exposes item metadata with **no auth**.

## Operations

### `getItemMetadata` — fetch item metadata by identifier

`GET /metadata/{identifier}` (e.g. `/metadata/nasa`) returns a **flat** object
with an embedded `files[]` array — no envelope, no pagination, no list op:

```json
{
  "created": 1783400013,
  "dir": "/nasa",
  "files": [ { "name": "…", "format": "…", "size": "…" } ],
  "files_count": 9,
  "is_collection": true,
  "item_size": …,
  "server": "ia…",
  "metadata": { "identifier": "nasa", "title": "…", … }
}
```

## Additional operations (rollout Batch B)

The 3 operations below were added during the rollout from the
`endpoint-coverage-plan.md` audit. All are read-only, no auth.

### `getItemField` — read a single top-level metadata field

`GET /metadata/{identifier}/{field}` fetches one top-level field of the item
metadata record (e.g. `/metadata/xfetch/server`) instead of the full record,
which can be multi-megabyte. Wraps the value in `{"result": …}`.

### `getItemFilesSlice` — slice of the files array

`GET /metadata/{identifier}/files?start=N&count=M` returns a slice of the
item's `files[]` array. `start` defaults to 0; `count` limits how many files
are returned. Useful to peek at an item's files without the full record.

### `searchItems` — search the full corpus

`GET /advancedsearch.php` is the Internet Archive Search API, a Solr wrapper.
Returns a Solr-style envelope: `response.numFound` (total matches) and
`response.docs[]` (this page's results). Paginated via `page` (1-based page
number; `start=(page-1)*rows`) and `rows` (page size, default 50).

`q` is a Solr query string supporting field queries (e.g.
`collection:opensource`, `creator:...`), `fl` selects the returned fields
(comma-separated), and `sort` orders results (e.g. `downloads desc`). All
take plain key=value form — no helper transform needed.

## How G10 fires

There is **no list op and no pagination at all** — a single resource fetch with
an embedded `files[]` array. This stresses the assumption "an API guide op
returns a paginated list": `restGet` without `paginate` is the correct shape.
Scalar typing is **mixed** (`created` is an epoch **int**, other fields are
strings) — `parseResponse` field coercion must not assume uniform typing.

## Terms

Internet Archive item-level metadata; access unrestricted.
<https://archive.org/developers/metadata.html>
