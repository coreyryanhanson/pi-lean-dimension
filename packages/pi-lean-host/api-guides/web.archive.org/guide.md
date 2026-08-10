---
kind: api
organization: archive.org
description: "Wayback capture history: CDX index queries and Memento time-travel lookups."
domains:
  - web.archive.org
shortName: Wayback CDX Server
icon: 🕰️
apiHost: https://web.archive.org
# The CDX server ignores the Accept header — `output=json` must be set as a
# query param or it returns tab-separated text. Locked as a default here so
# every queryCdx call gets the JSON array.
# (getTimemap overrides at op level: text/plain link-format.)
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-08-08"
docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
operations:
  - name: queryCdx
    via: restGet
    path: /cdx/search/cdx
    accept: json
    transform: true
    params:
      url:
        required: true
        description: The URL to look up captures for (host form, e.g. `example.com`, or with a path). The executor URL-encodes the value; pass the raw URL.
      output:
        default: json
        description: Response format. Must be `json` (default) to get the JSON array; the API returns tab-separated text otherwise.
      matchType:
        default: exact
        description: Match scope — exact (default), prefix, host, or domain.
      limit:
        default: 10
        description: Max captures to return. Negative N returns the last N (e.g. `-1` = most recent).
      from:
        description: Inclusive start of timestamp range, compact form (yyyyMMddhhmmss, 1-14 digits, e.g. 2010).
      to:
        description: Inclusive end of timestamp range, compact form (yyyyMMddhhmmss).
      fl:
        description: Comma-separated subset of fields to return (urlkey,timestamp,original,mimetype,statuscode,digest,length default).
      filter:
        description: Repeatable `[!]field:regex` filter, e.g. `filter=!statuscode:200`. Pass one filter per call; the API accepts repeats.
      collapse:
        description: Repeatable `field[:N]` de-dupe of adjacent captures, e.g. `collapse=timestamp:10` (1 per hour) or `collapse=digest`.

  - name: getTimemap
    via: restGet
    path: /web/timemap/link/{url}
    accept: text/plain
    parse:
      format: text
# Memento TimeMap surface: getTimemap lists every capture (rel=memento)
# with its datetime. The timegate (`/web/{timestamp}/{url}` redirect) is
# what Availability's getClosestSnapshot answers; the raw page fetch is
# browser territory, so this guide stops at the index surface (ponytail:
# add a timegate op only if agents need to fetch archived page bodies).
---
# Wayback Machine — CDX Server + Memento TimeMap

The Wayback Machine's index-query surface on `web.archive.org`: the **CDX
Server API** lists archival captures of a URL, and the **Memento TimeMap**
lists every snapshot (memento) with its capture datetime. Both are read-only,
no auth.

> **Multi-recipe note:** this guide shares `organization: archive.org` with
> the Item Metadata guide (`archive.org/`) and the Availability guide
> (`archive.org-wayback/`). `domains: [web.archive.org]` is distinct, so it
> never disambiguates — it routes by domain like a single-guide API.

## Operations

### `queryCdx` — query the capture index

`GET /cdx/search/cdx?url=…` returns archival captures of a URL. With
`output=json` (default here) the body is a **JSON array of arrays**: element 0
is the field-name header, each following element is one capture as a row of
values in the same order. Example:

```json
[
  ["urlkey","timestamp","original","mimetype","statuscode","digest","length"],
  ["com,example)/","20020120142510","http://example.com:80/","text/html","200","HT2D…","1792"],
  ["com,example)/","20020328012821","http://www.example.com:80/","text/html","200","UY3I…","481"]
]
```

The first element self-documents the columns, so the raw form is usable.
A `transform` named export in this guide's `helper.ts` zips each row
against the header into `[{ urlkey, timestamp, … }, …]` — see the
`transform: true` field on `queryCdx`. If the transform throws, the raw parsed
body is returned with a warning
(graceful, no disable).

Matching is `exact` by default; `matchType=prefix|host|domain` broadens it.
`from`/`to` bound the timestamp range, `fl` narrows the fields, `filter`
removes rows by `[!]field:regex`, and `collapse` de-dupes adjacent captures.
`limit=-1` is the natural "most recent capture" call.

> Pagination: the CDX server supports resume-key pagination for bulk dumps.
> `via: restGet` + `limit` covers the query use cases; bulk harvesting is not
> this guide's job (ponytail: add via the resume-key style only if bulk
> becomes a real need).

### `getTimemap` — list all snapshots (Memento TimeMap)

`GET /web/timemap/link/{url}` returns every capture of a URL as Memento
**link-format text** (one `<url>; rel="memento"; datetime="…"` per line, the
Memento standard shape). Pass the full target URL for `{url}` (e.g.
`https://example.com/`); the executor URL-encodes it into the path segment.

```text
<https://web.archive.org/web/20020120142510/http://example.com:80/>; rel="first memento"; datetime="Sun, 20 Jan 2002 14:25:10 GMT",
<https://web.archive.org/web/20020328012821/http://example.com:80/>; rel="memento"; datetime="Thu, 28 Mar 2002 01:28:21 GMT",
…
```

The set of `rel="memento"` lines is the full capture history with datetimes;
the `first`/`last` memento lines bound the range. `?output=json` is **not**
supported (the parameter is appended to the target URL, verified live).

## Terms

Wayback Machine index access; unrestricted for reasonable query volume.
<https://github.com/internetarchive/wayback/>
