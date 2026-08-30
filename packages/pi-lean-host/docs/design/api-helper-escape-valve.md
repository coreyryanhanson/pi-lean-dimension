# API Helper Escape-Valve Policy

> Partition between what the framework implements **built-in** and what it
> defers to a **local-helper** (user-authored `helper.ts`). This is the design
> decision record — *what* is built-in is visible in the code, but *why* a
> quirk is deliberately kept on the local-helper side of the boundary is not.
> The recipe-by-recipe evidence that drove each classification lives in the
> [caritas](https://github.com/coreyryanhanson/caritas) recipe repo; host ships
> only the synthetic axis guides under `api-guides/`, which keep the axes
> exercised in-repo (see `axis-coverage.test.ts`, which encodes the axis-set
> audit matrix).

## The two mechanisms

A quirk is either realized by the framework or deferred to a user helper:

- **Built-in** — implemented once in the core (`parse-api-guide.ts`,
  `helpers.ts`, `transport.ts`, `path-template.ts`) so every guide gets it.
- **Local-helper** (`core/local-helpers.ts`) — a user-authored `helper.ts`
  beside the guide at `~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts`,
  loaded on demand when an op sets `helper: true`. Pre-call transform only:
  `(params, ctx) => params`, reshapes the params before URL templating / query
  assembly. One helper per domain. A load/execution throw disables it for the
  session.

A third, distinct mechanism — **post-response `transform`** — is a gated
built-in: an op declares `transform: true` to run a named `transform(data, ctx)`
export from the same `helper.ts` after `parseResponse` (`restGet`) or per-item
(`paginate`). Graceful by contract: a throw is caught per-call — the agent gets
the raw data with a warning, never a disabled op (`paginate` routes failed items
to a `failedItems` group; no item dropped). Cannot inspect response headers.

## Classification boundary

| Quirk class | Built-in (framework) | Local-helper / deferred |
|---|---|---|
| Pagination styles | `offset-limit`, `nextLink` (SSRF-guarded), `cursor`, `page`, `resumptionToken`, `tokenBag` | `Link`-header pagination (RFC 5988) — deferred, needs a header-aware style |
| Response formats | JSON, XML (`fast-xml-parser`, `removeNSPrefix`) | — |
| Charsets | UTF-8 + any IANA charset via `TextDecoder` (guide `charset` as fallback) | — |
| Content negotiation | `accept: json`/`xml` shorthands, free-form media strings | Query-param negotiation is just a param default — not a helper |
| Auth | `auth.kind: none`, `auth.headers` (extra headers, e.g. `DEMO_KEY`), `static-key` (secrets store + fail-closed), `oauth2` (both grants — cc auto-mint / auth-code paste flow, Bearer or query injection, multi-grant slots) | `User-Agent` POLICY (not expressible in a guide; UA via transport config or `auth.headers`) |
| Pagination edge signals | empty-array stop, non-array wrap-and-continue, server-total surfacing (`totalCountPath`), continue-token bag (`tokenBag`), OAI `resumptionToken` | `endOfRecords: true` bool, count-bounded stop via a total field, `Link` header |
| Rate-limit signaling | HTTP 429 + exponential backoff + `Retry-After` (delay-seconds and HTTP-date) | `X-RateLimit-*` (informational only, agent reads headers) |
| Caching / conditional | `Cache-Control` TTL, ETag/`If-None-Match` → 304, `Expires` fallback | — |
| Response shape / envelope | flat envelope, nested envelope (`itemsPath: result.items`), non-flat items (passed through), GeoJSON `FeatureCollection`, JSON-LD / linked-data, single-resource (`restGet`), mixed field naming (choose one path) | Language-keyed dict (`entities.{id}.labels.{lang}`) |
| Date transforms | declarable `dateParams` query-param normalization (ISO → `yyyymmdd` / `yyyy-mm-dd` / `iso8601`) | Path-param dates, non-standard formats, context-dependent transforms |
| Query DSL / param transforms | — | JSON-query DSL wraps (`toBoeQuery`), any per-API param transform |
| Local-helper contract | signature `(params, ctx) => params`, pre-call only, async support, one-per-guide, gated post-response `transform` | per-param helper binding (out of scope) |

The synthetic axis set keeps every guide-driven axis covered in-repo: all six
pagination styles, both `transform × via` combos (restGet + paginate), all
three realized auth kinds (none + static-key + oauth2 — the `twitch` /
`twitch-user` pair carrying `client_credentials` + `authorization_code` on one
store domain), XML parsing, local-helper, SSRF guard (nextLink), and
multi-recipe domains (`internet-archive` + `wayback-availability`, plus the
auth-slot sibling split `twitch` + `twitch-user` on `twitch.tv`).
`axis-coverage.test.ts` is the regression tripwire pinning that set.

## When to upgrade a local-helper quirk to built-in

Promote a **local-helper** classification to **built-in** when:

1. A second independent API exhibits the same quirk (e.g. a second API needing
   header-based pagination).
2. The fix is a small, well-understood change to a single function (a new
   `paginate` style, array normalization in `parseResponse`).
3. The local-helper workaround is fragile — e.g. the helper must inspect
   response headers, which the pre-call contract forbids.

The breakable boundary ("break freely to generalize") applies: if a new API
forces a generalization, break the helper rather than papering over the quirk
in a guide.

## Deferred / out of scope

- **`Link`-header pagination** — only known recipe uses header-based pagination;
  no helper valve can see headers (pre-call runs pre-request, `transform` sees
  only the parsed body). Would need a header-aware pagination style.
- **General mutations / write gate** — transport is GET-only (`restGet`,
  `paginate`); scoping is behavioral (provision read-only keys).
- **Cookie-login / session continuity** — separate capability; core is
  stateless per-request. Deferred until a recipe forces it.
