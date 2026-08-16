# pi-lean-host User Guide

> **pi-lean-host** gives the Pi coding agent declarative access to REST APIs —
> recipe-based guides that encode an API's endpoints, auth, pagination, and
> response shape once, then execute through a small set of managed tools. The
> agent never hand-rolls auth headers, never picks the wrong `Accept`, never
> re-derives pagination from scratch each session. A `/api` toggle (peer to
> `/web`) hides the tools from context on sessions that aren't doing API work,
> and `/api on` + `/web off` gives a pure **api-only** context with zero
> `browser-*` noise for batch structured-data pulls.
>
> Some sites are hostile to scrape but expose a clean, documented API.
> `pi-lean-host` is the structured-data answer to that gap — author the API
> once, reuse it forever.
>
> Part of the [pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)
> web-tools suite. Host-only installs are valid — **`pi-lean-portal` is an
> optional peer dependency**. For interactive browsing, install
> [`pi-lean-portal`](https://www.npmjs.com/package/pi-lean-portal); for
> SearXNG search, install
> [`pi-lean-search`](https://www.npmjs.com/package/pi-lean-search).

> ⚠️ **Early release (0.2.0).** The API tools here work today, but this is a
> development preview. The recipe schema, tool surfaces, and guide format are
> still settling as we test more APIs to finalize the shape — **future
> compatibility is not guaranteed** until the package reaches lockstep with
> `pi-lean-dimension` 0.5.0. Guides authored against 0.2.x may need revision
> as the schema firms up.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [The Big Idea: Recipes, Not a Runtime](#the-big-idea-recipes-not-a-runtime)
3. [`/api` Command — API Toggle](#api-command--api-toggle)
4. [All 4 Tools](#all-4-tools)
5. [Guide Recipes (the `recipe` block)](#guide-recipes-the-recipe-block)
6. [Authoring a Guide](#authoring-a-guide)
7. [Local User Helpers](#local-user-helpers)
8. [Pagination Styles](#pagination-styles)
9. [Response Shapes (`parseResponse`)](#response-shapes-parseresponse)
10. [Multi-Recipe Domains](#multi-recipe-domains)
11. [Bundled Reference Recipes](#bundled-reference-recipes)
12. [`/api status` — Detailed Runtime Status](#api-status--detailed-runtime-status)
13. [Configuration (`settings.json`)](#configuration-settingsjson)
14. [Co-Installing with `pi-lean-portal`](#co-installing-with-pi-lean-portal)
15. [Authentication & Secrets](#authentication--secrets)
16. [Tips & Best Practices](#tips--best-practices)
17. [Security & Scope](#security--scope)

---

## Quick Start

```bash
pi install npm:pi-lean-host
```

No browser binaries, no server, no setup wizard. The host tools are **enabled
by default** — you'll see:

> 📡 API tools enabled. /api learn to make api-learn + api-probe available.

From a fresh install you have no guides yet, so the workflow is:

1. **`/api learn`** — enable the authoring tools (`api-learn` + `api-probe`).
2. **`api-probe({apiHost, path})`** — discover the shape of a not-yet-guided
   endpoint; it drafts a YAML operation block to paste into a recipe.
3. **`api-learn({domain, recipe})`** — write the guide to
   `~/.pi/agent/pi-lean-host/api-guides/<domain>/guide.md`.
4. **`api-fetch({domain, operation})`** — execute and verify.

Or skip the authoring and **copy a bundled reference recipe** (see
[Bundled Reference Recipes](#bundled-reference-recipes)) into
`~/.pi/agent/pi-lean-host/api-guides/<domain>/` — it loads immediately.

> **Host-only is a first-class install.** `pi-lean-host` declares
> `pi-lean-portal` as an *optional* peer dependency and has zero static
> imports from it. The core loop — authoring via docs/example, on-demand
> discovery, guided execution — runs with no browser package installed.
> Co-installing portal is planned to unlock two additive features
> (navigate-footer surfacing and probe-authoring via `web-fetch`) in a
> **future release**. Host-side projection code is present but inert
> until portal ships the receiving global (`__piLeanPortalRegisterGuideProvider`).

---

## The Big Idea: Recipes, Not a Runtime

The single most important discipline: **only files you place in
`~/.pi/agent/pi-lean-host/` execute.** An API guide is a markdown file with
YAML frontmatter declaring endpoints, auth, pagination, and response shape.
A managed tool (`api-fetch`) executes the declared operation through a small
fixed set of built-in helpers. The agent never writes TypeScript against the
API — it authors (or copies) a recipe, and the tool does the call.

This kills two whole classes of recurring mistakes before they exist:

- **Agents getting the same API wrong every session.** The reason they do is
  *they are the ones writing the calls.* Move call construction into a
  reviewed tool + fixed helpers, and the agent never touches the auth
  header, never hand-rolls pagination, never picks the wrong `Accept`.
- **Arbitrary eval / egress safety.** Executable TS in a guide is a sandbox
  problem. Declarative recipes executed by a fixed tool are not — and because
  bundled recipes are inert, the only code that ever runs is code you
  explicitly placed in your own directory.

### Why not just a skill?

A skill is prose the agent re-interprets each turn; this plugin is a fixed
executor it calls through. For a single clean endpoint you call
occasionally, a few skill lines are the lazier answer. It earns its keep
where re-derived curl goes wrong — **pagination to exhaustion** (cursor,
nextLink, OAI-PMH tokens, Wikimedia continuation dicts walked in one call by
reviewed code), **charset traps** (Latin-1 APIs serving bytes without a
charset parameter — fixed once in the transport, not re-applied and
forgotten), and **in-process TypeScript helpers** that transform params or
responses directly (a skill can only instruct the agent to write and run
that code). A skill is also always in context; the guide store loads on
demand. A skill is pure text with no in-process eval, whereas a loaded
`helper.ts` runs with the agent's privileges.

### Three tiers of code, separated by trust

| Tier | Where it lives | Who writes it | Ships in tarball? | Trust |
|------|----------------|---------------|-------------------|-------|
| Built-in helpers | package source (`core/`) | maintainers | yes | reviewed |
| Local user helpers | `~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts` | you, or the agent in `/api learn` | no | user-owned |
| Bundled recipes | `caritas` repo (`api-guides/<domain>/`) | maintainers | no (reference) | **inert — never auto-executed** |

Built-in helpers cover the common 90%. Local user helpers cover the weird 10%
(computed signatures, strange date transforms, custom auth). Bundled recipes
are inert reference material in the [`caritas`](https://github.com/coreyryanhanson/caritas)
repo — the loader never reads `api-guides/` from the package. You adopt one by
copying the whole domain folder into your own directory; only then does it
load and execute.

---

## `/api` Command — API Toggle

`/api` is an **independent peer** of `/web`, not a child. They compose
freely: each owns its own tool set and its own status-bar slot, and neither
touches the other's tools.

| Command | Effect |
|---------|--------|
| `/api on` | **API access** — `api-guide` + `api-fetch` available. Authoring tools hidden. (Default for new sessions.) |
| `/api learn` | **API access + authoring** — adds `api-learn` + `api-probe` on top of `on`. The agent never authors guides unprompted — it must be in learn mode. |
| `/api off` | **All API tools hidden** — removes `api-*` from the agent's context to save tokens on sessions that aren't doing API work. |
| `/api` | Show current state and available sub-commands. |
| `/api status` | Detailed runtime status — state, active guides, domains, helpers. |
| `/api helpers` | List local user helpers (or `/api helpers <domain>` to view one's source). |
| `/api secrets [<domain> [<name>]]` | Manage stored API secrets — list, provision, delete (see [Authentication & Secrets](#authentication--secrets)). |

### Why a peer toggle?

The concrete win is **api-only mode**: `/api on` + `/web off` turns off every
`browser-*` tool while keeping structured API access live. That's the workflow
that pays for the machinery — batch structured-data pulls against a known API
(paginating a JSON endpoint to exhaustion, querying a documented read API
across many dates) where the browser tools are pure context noise you want
gone, but API access must stay on. A `/web`-child toggle cannot give you
that — `/web off` would kill both together.

### Persistence

Toggle state persists via the [`pi-tool-masking`](https://github.com/coreyryanhanson/pi-tool-masking/)
library (`persistKey: toolset-state:pi-lean-dimension.api`), surviving
`/reload`, `/resume`, `/fork`, and `/tree` navigation. A fresh conversation
starts from the `toolsetDefaults` block in merged Pi settings (see
[Configuration](#configuration-settingsjson)), falling back to the packaged
default (`on` for `api`, `off` for `api-learn`).

The status bar shows an `api` glyph (independent of the `browser`/`search`
slots). It reads `● api` when `/api` is on (colored to reflect learn state)
and `○ api` when off.

---

## All 4 Tools

`pi-lean-host` registers 4 tools. `api-guide` and `api-fetch` are available
under `/api on`; `api-learn` and `api-probe` are added under `/api learn`.

The four tools split cleanly by side-effect boundary — one each for **local
read**, **network read**, **local write**, and **network read (exploratory)**:

### 1. `api-guide` — Inspect the Guide Store (local read)

```text
api-guide → list all available API guides (catalog)
api-guide domain="wikipedia.org" → disambiguation menu (two guides claim the domain)
api-guide domain="wikipedia.org" guide="Wikipedia REST" → selected guide
```

- No parameters → the full catalog (collapsed by `organization:`).
- `{domain}` → the guide's detailed operation list, or a disambiguation menu
  when more than one guide claims the domain.
- `{domain, guide}` → the selected guide, resolved by `shortName`.

When a guide is malformed on disk it shows with a `⚠ malformed` badge and the
error inline rather than silently disappearing — so you can fix the one
broken field instead of re-authoring from scratch.

### 2. `api-fetch` — Execute a Guided Operation (network read)

```text
api-fetch domain="wikipedia.org" operation="getPageSummary" params={title:"Albert_Einstein"}
api-fetch domain="wikipedia.org" operation="searchPages" params={srsearch:"climate"} gatherAll=true
```

**Parameters:**

- `domain` — a domain registered in a guide (e.g. `"wikipedia.org"`).
- `operation` — an operation name from the guide (e.g. `"getPageSummary"`).
- `params` (optional) — path and query parameter values for the operation.
- `gatherAll` (optional) — `true` paginates to gather all items up to the
  guide's `gatherAllMax` ceiling (default `1000`, overridable per-guide and
  per-op).

`api-fetch` resolves every guide claiming `domain`, finds the named
`operation` across them, and executes it against the matching guide (helper
routed by directory name, not the routing `domain`). The agent never sees a
URL, never sees a header, never sees the auth scheme. Output is an inline
preview (~4000 chars) with larger responses spilled to a temp file under
`/tmp/pi-lean-host/` (overridable via `PI_HOST_TEMP_DIR`) — `read` it with
offset/limit for specific sections.

When no guide exists for the domain, the call **fails informatively** and
points at `api-guide({})` (to list guided domains) and `api-learn` (to author
one) — turning a failed execute into a discovery moment in one round-trip.

### 3. `api-learn` — Author / Update a Guide (local write)

```text
api-learn                                       → worked example recipe + field reference
api-learn domain="boe.es" recipe="---\nkind: api\n…"   → writes the guide to disk
```

- No parameters → a complete worked-example recipe (the BOE shape, exercising
  the core fields) plus a concise field reference. Read once at
  authoring time, never carried on executing turns.
- `{domain, recipe}` → validates the recipe string **before** touching disk,
  then writes to `~/.pi/agent/pi-lean-host/api-guides/<domain>/guide.md`,
  overwriting any existing guide for that domain. On a structural error it
  names the field, the expected shape, and what was found — the file on disk
  is left untouched (no half-written guide). Requires `/api learn`.

There is no draft store, no `/api save`, no session-held state — the file on
disk *is* the working state, exactly like `web-learn`. If the recipe is wrong,
call `api-learn` again to overwrite.

### 4. `api-probe` — Discover an Endpoint's Shape (network read, exploratory)

```text
api-probe apiHost="https://api.github.com" path="/repos/{owner}/{repo}/branches" params={owner:"torvalds", repo:"linux"}
```

Shape-discovery for the authoring loop. Fetches a templated path over the
real transport (same UA, charset, 429-retry, ETag cache as `api-fetch` — the
sanctioned way to reach even WAF'd hosts), summarizes the JSON shape, suggests
`via` / `itemsPath` / pagination style, echoes a representative record id, and
emits a **draft YAML operation block** to paste straight into a recipe. On 404
it auto-tries `/v1` and `/v2` prefixes (disable with `tryPrefixes=false`).

`api-probe` only **suggests** — it never writes the guide. The operation must
still be traceable to your plan source (the API docs or a working curl
example); this tool surfaces evidence, not authority. Requires `/api learn`.

---

## Guide Recipes (the `recipe` block)

A guide is one markdown file: YAML frontmatter carries the structured recipe
(the executable contract), and a prose body carries orientation for the
agent (advisory). `api-fetch` reads the recipe slice and executes against it;
`api-guide` reads the detail slice for introspection. **The prose is
advisory, the frontmatter is authoritative.**

### A complete example (the BOE shape)

```yaml
---
kind: api
domains: [boe.es, www.boe.es]
icon: ⚖️
shortName: BOE
updated: 2026-07-17
# organization: boe.es        # optional — org identity across guides
# description: BOE open-data API.  # optional — ≤200 chars, one line; aids disambiguation
apiHost: https://apidatos.boe.es/v1
verified: 2026-07-17
gatherAllMax: 500

auth:
  kind: none

pagination:
  style: offset-limit
  pageParam: page
  pageSizeParam: limit
  pageSize: 50
  itemsPath: data
  # totalCountPath: meta.totalCount   # optional, any style → server total in the footer

responseShape:
  format: json
  charset: utf-8

operations:
  - name: searchDiary
    via: restGet
    path: /diario/{date}
    accept: json
    params:
      limit:
        default: 50
    helper: true          # run this domain's local helper.ts for this op
    parse:
      format: xml
      charset: iso-8859-1

  - name: listConsolidada
    via: paginate
    path: /legislacion-consolidada
    accept: json
    pagination:
      style: cursor
      cursorParam: cursor
      cursorPath: pagination.nextCursor
      itemsPath: results
    gatherAllMax: 1000     # op-level ceiling override
---
# BOE Legislación Consolidada — structured API access

Use `api-fetch` with `searchDiary` to pull a day's dispatch (pass `date` as
`YYYYMMDD`). Use `listConsolidada` with `gatherAll: true` to walk consolidated
laws (capped at 1000 by the op override). The `boe-datefmt` helper formats the
`date` param; it lives at
`~/.pi/agent/pi-lean-host/api-guides/boe.es/helper.ts`.
```

### Field reference

| Field | Level | Default | Purpose |
|---|---|---|---|
| `kind` | guide | `"api"` | the guide type; defaults to `"api"` and is omittable. Values like `"web"` are rejected for API guides. |
| `domains` | guide | — | discovery keys (plural bare aliases) |
| `icon` / `shortName` / `updated` | guide | `📖` / filename / today | presentation slice (portal + `api-guide`) |
| `apiHost` | guide | — | execution root: scheme + host + base path; the version prefix lives here |
| `organization` | guide | — | optional org identity (registrable domain); catalog grouping + disambiguation. Recipe-slice only |
| `description` | guide | — | optional one-line summary (≤200 chars); primary disambiguation signal for multi-guide domains |
| `docs` | guide | — | optional canonical API documentation URL (http/https); surfaced in api-guide detail |
| `verified` | guide | creation date | drift signal — **defaulted, not enforced** |
| `gatherAllMax` | guide / op | `1000` | `gatherAll` ceiling; an op can override |
| `auth.kind` | guide | `none` | `none` \| `static-key` (store-backed header/query secrets). `oauth2` is a declared-but-unrealized seam (rejected at parse) |
| `auth.headers` | guide | — | literal extra headers merged into every request (e.g. X-Api-Key: DEMO_KEY) — **literal values only**, never the path for real credentials |
| `auth.secretRefs` | guide | — | `Record<headerName, secretName>` — store-backed header injection (`static-key`) |
| `auth.secretQueryRefs` | guide | — | `Record<paramName, secretName>` — store-backed query-param injection (`static-key`) |
| `auth.requires` | guide | — | secret names the guide hard-requires; absent → `api-fetch` fails closed before the request |
| `auth.optional` | guide | — | secret names used if present, skipped if absent (e.g. GitHub rate-limit token) |
| `pagination.style` | guide / op | required when `via: paginate` | `offset-limit` \| `nextLink` \| `cursor` \| `page` \| `resumptionToken` \| `tokenBag` |
| `pagination.itemsPath` | guide / op | — | JSON path to the items array in the body |
| `pagination.totalCountPath` | guide / op | — | optional, any style → server-reported total surfaced as `serverTotal` / `server total: N` |
| `responseShape.format` | guide / op | `json` | `json` \| `xml` \| `text` → drives `parseResponse` (`text` is raw passthrough) |
| `responseShape.charset` | guide / op | `utf-8` | `utf-8` or any IANA charset name (e.g. `iso-8859-1`); used as a fallback when the response's Content-Type header omits a charset — an explicit header charset wins |
| `operations[].name` | op | — | the `operation` arg `api-fetch` takes |
| `operations[].via` | op | — | executor: `restGet` \| `paginate` |
| `operations[].path` | op | — | relative path; `{token}` = inferred path param (no re-declaration) |
| `operations[].accept` | op | `json` | `json` \| `xml` \| `<any media-type string>` — request-side `Accept` header (distinct from `responseShape.format`) |
| `operations[].params` | op | `{}` | query params; `{ required?, default?, description? }` per key |
| `operations[].dateParams` | op | — | optional `{param: format}` → normalizes ISO dates to `iso8601` \| `yyyymmdd` \| `yyyy-mm-dd` (query params only) |
| `operations[].helper` | op | `false` | `true` runs this domain's local helper for the op |
| `operations[].transform` | op | `false` | `true` runs the helper's `transform` export on the parsed response (graceful — a throw returns raw data, never disables the op) |
| `operations[].passthrough` | op | `false` | `true` forwards undeclared caller params onto the query string (for open-param APIs) |
| `operations[].parse` | op | inherits `responseShape` | op-level override of format/charset |
| `operations[].pagination` | op | inherits top-level | op-level override of pagination |

### Built-in helpers (the fixed executor set)

Three helpers, for v1. The agent never calls these directly — `api-fetch`
routes each operation through the one its `via` names:

- **`restGet`** — path templating, query params, Accept negotiation
  (JSON/XML), and auth injection for `auth.kind: static-key` guides
  (store-backed `secretRefs` / `secretQueryRefs`). See [Authentication &
  Secrets](#authentication--secrets).
- **`paginate`** — wraps a list operation. The guide declares the style; the
  helper follows it. Returns `{items, next?, serverTotal?}` so the agent can
  stop or continue, plus a `gatherAll` flag for the "just get me everything"
  case with a hard ceiling.
- **`parseResponse`** — XML→JSON, declared per-endpoint (charset decoding happens in the transport).
  Agents mangle encodings constantly; fix it once here.

`restPost`/mutations are **not** in scope for v1 — the target APIs are
overwhelmingly GET-read.

### Recipe drift

A prose guide degrades gracefully; a declarative recipe with a wrong endpoint
fails **hard**. v1 treats drift as a signal the agent reads, not a gate the
loader enforces:

- The `verified` frontmatter date records when a guide was last verified
  against the live API (defaulted to creation date, **never enforced**). It's
  rendered in the guide-detail footer alongside the current date — the agent
  reads both and judges.
- The **live HTTP response is the actual drift signal.** A 401 on a no-auth
  guide, a 404 on a pinned path, a changed response shape — the agent reads
  those directly. The `verified` date is predictive; the response is actual.

---

## Authoring a Guide

The authoring model is **spec-first, probe-second**: read the contract and
encode it, then verify the encoding. The trial-and-error lives at the
*verification* step, not the discovery step. The loop is:

```
api-learn (write)  →  api-fetch (verify)  →  api-learn (fix)  →  api-fetch (verify)
```

exactly like the browser's `web-learn → browser-navigate → web-learn` loop,
just at the recipe layer. `api-learn`'s return message nudges this
("guide saved; call `api-fetch(...)` to verify"). A guide on disk that has
been successfully executed against *is* verified.

### Authoring paths, prioritized

1. **Documentation-driven (primary, works host-only).** Read the API's docs
   — via `web-fetch` (portal) or pasted/filepath (host-only) — encode them as
   a recipe via `api-learn`, verify with `api-fetch`. The docs *are* the
   affordance; this is the natural default.
2. **Example-generalization (works host-only).** Paste a working curl command
   or code sample; the agent generalizes from the one example to a recipe.
   A single working call teaches the base URL, the Accept header, the
   response shape.
3. **Probe-and-verify (needs portal, last resort).** Use `api-probe` (or
   portal's `web-fetch`) to hit endpoints, read responses, build a candidate
   recipe. Possible, but reading the docs is cheaper than probing.
4. **OpenAPI/Swagger import (deferred).** A spec→recipe transformer is
   mechanical when a machine-readable spec exists; build it when a second
   guide with a spec arrives.

**Known limitation — api-only is a known-domains mode.** If your request
doesn't name a domain and no guide in the catalog matches, the agent can't
discover a brand-new API from scratch in api-only mode. That requires web
tools (to search/browse and find the API) or you supplying the domain. It's
an inherent trade-off of a clean api-only context, not a design flaw.

---

## Local User Helpers

For sites that need a computed signature, a strange date transform, or a
custom auth flow a declarative recipe can't express — one local user helper
per guide:

- **Location:** `~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts`
  (alongside the guide's `guide.md`).
- **Authoring gate:** `/api learn` (the explicit opt-in, mirroring `/web
  learn`). **Execution gate:** `/api on` only — a persisted helper runs on
  later sessions whenever a guide references it, even outside learn mode.
- **Pre-call contract:** `(params, ctx) => params | Promise<params>` — a
  transform that receives the resolved param map (path + query merged,
  defaults filled) and returns the final map the executor templates and sends.
- **Post-response transform (gated):** an optional `transform(data, ctx)`
  *named export* from the same `helper.ts`, run when an op declares
  `transform: true`. Graceful by contract — a throw is caught per-call and
  the agent gets the raw untransformed data with a warning, never a disabled
  op. Cannot inspect response headers.

### Safety model

Local helpers run **in-process** via `import()` with the agent's privileges —
no process boundary. This is a deliberately new isolation profile in the
codebase: stealth backends run as out-of-process Python subprocesses (a crash
is caught; pi keeps running), whereas local helpers load in-process. The
mitigations:

- A load/call guard wraps both `import()` and each call in `try/catch`. Any
  in-frame throw (syntax error, missing dep, throw during execution) rejects
  the promise — it does **not** crash pi. On failure the helper is marked
  disabled for the session and surfaced via `/api status` (and the status-bar
  glyph). pi keeps running; only that one helper is dead until you fix it and
  reload.
- The one case the guard **cannot** catch is a helper that registers a
  *background* callback (`setTimeout`, `setInterval`, `process.on(...)`) and
  throws from it later — that escapes the call frame as an
  `uncaughtException` and can take pi down. **The helper-author rule:
  synchronous-pure or fully awaited, no background work.** That covers every
  realistic v1 helper (format a query string, sign a header, compute a date).
  If a real keyed guide ever needs background work, isolation (worker thread
  or subprocess) gets revisited then.
- A persisted helper can make arbitrary network calls on later sessions. The
  mitigation is user ownership and review, not a sandbox.

View helpers with `/api helpers` (list) or `/api helpers <domain>` (source).
Authoring is via `api-learn` in learn mode, or hand-editing the file.

---

## Pagination Styles

`paginate` follows the style declared in the recipe. Six styles cover the
patterns the recipe library (caritas) pressure-tested:

| Style | What it sends | Key fields |
|-------|---------------|------------|
| `offset-limit` | absolute offset + page size | `pageParam`, `pageSizeParam`, `pageSize`, `itemsPath` |
| `page` | 1-based page number + page size | same fields as `offset-limit` (semantic difference only) |
| `nextLink` | follows a URL from the response body | `nextLinkPath`, `itemsPath` — the **only** SSRF-guarded path (see [Security](#security--scope)) |
| `cursor` | echoes an opaque cursor query param | `cursorParam`, `cursorPath`, `itemsPath` |
| `resumptionToken` | OAI-PMH opaque single-token cursor | `tokenParam`, `tokenPath`, `itemsPath` |
| `tokenBag` | Wikimedia-style multi-key continuation dict | `continuationParams[]`, `itemsPath` |

`totalCountPath` is optional on any style — a JSON path to the server's
reported total, surfaced as `serverTotal` in the `paginate` result and as
`server total: N` / `remaining: …` in the `api-fetch` footer. Omit it when
the API exposes no total.

`pagination` and `responseShape` are top-level defaults; an individual
operation overrides them with its own block.

---

## Response Shapes (`parseResponse`)

Agents mangle encodings constantly; `parseResponse` fixes it once. Declared
per-guide (top-level `responseShape`) and overridable per-op (`parse:`):

- `format: json | xml | text` — XML is converted to JSON via `fast-xml-parser`; `text` is raw passthrough.
- `charset: utf-8 | <IANA name>` — the transport decodes using the response's Content-Type charset, falling back to this value when the header omits one (essential for Latin-1 / ISO-8859-1 APIs like BOE that serve bytes without a charset parameter). An explicit header charset always wins.
- `accept` (request-side, on each operation) is declared **independently**
  from `responseShape.format` (response-side) — they usually match but an API
  may return XML regardless of `Accept`, so they're separate fields.

---

## Multi-Recipe Domains

A domain may claim **multiple guides** — each in its own directory (e.g.
`archive.org` + `archive.org-wayback`). `buildDomainMap` is multi-valued
(`Record<string, string[]>`):

- `api-guide({domain})` shows a **disambiguation menu** and accepts a `guide`
  selector (resolved by `shortName`).
- `api-fetch({domain, operation})` resolves the operation **by name across
  all matching guides** — exactly one hit executes (helper routed by the
  guide's directory name, not the routing `domain`); zero lists ops from all
  matches; an op name appearing in ≥2 guides is an ambiguous collision the
  authors must fix (re-author via `api-learn` to rename).

Optional `organization:` (catalog grouping) and `description:` (≤200 chars,
the primary disambiguation signal) fields help the catalog and menu stay
legible when several guides share a domain. `api-learn` warns on collision so
you know you're in disambiguation territory.

---

## Bundled Reference Recipes

The comprehensive recipe library lives in the
[**caritas**](https://github.com/coreyryanhanson/caritas) repo — real,
verified recipes spanning the no-auth **and keyed** axes, each with a
per-recipe `verified:`-date provenance and the perpetual drift disclaimer.
They are inert reference material: nothing executes until you copy a recipe
into your own `~/.pi/agent/pi-lean-host/api-guides/<domain>/` directory.

The domains caritas covers (a discoverability index, may drift from the live
repo):

```
api.gbif.org             api.github.com           archive.org              archive.org-wayback
arxiv.org                boe.es                   coingecko.com            data-api.ecb.europa.eu
datos.gob.es             earthquake.usgs.gov      en.wikipedia.org         en.wikipedia.org-action
etherscan.io             eutils.ncbi.nlm.nih.gov  gitlab.com               loc.gov
musicbrainz.org          openlibrary.org          resources.data.gov       services.dnb.de
web.archive.org          www.federalregister.gov  www.wikidata.org
```

Several are **keyed** (`auth.kind: static-key`), the spread that exercises
header-vs-query refs and the required/optional split (see [Authentication &
Secrets](#authentication--secrets)).

To use them, copy the guides into your own directory from a clone of caritas:

```bash
git clone https://github.com/coreyryanhanson/caritas.git /tmp/caritas
cp -r /tmp/caritas/api-guides/* ~/.pi/agent/pi-lean-host/api-guides/
```

To grab a single domain instead of all of them, copy just its folder
(e.g. `.../api-guides/en.wikipedia.org`).

Only then does it load and execute. A recipe may carry
`operation.helper: true` plus an accompanying `helper.ts` in its domain
subdir as a worked example — but it stays inert until you copy the folder.
See caritas's `CONTRIBUTING.md` for authoring a recipe, and
[`docs/design/api-helper-escape-valve.md`](docs/design/api-helper-escape-valve.md)
for the per-recipe quirk breakdown and the built-in vs local-helper
classification.

### What host ships instead

Host itself ships only a **synthetic axis-guide set** under `api-guides/` —
minimal coverage fixtures (no `verified:` date, no live endpoints) that keep
every guide-driven framework axis exercised via mocked transport. They are
framework fixtures for host's own tests, not recipes for you to copy. See
[`docs/design/axis-set-audit.md`](docs/design/axis-set-audit.md) for the
membership.

---

## `/api status` — Detailed Runtime Status

```text
/api status
```

```text
📡 API status
  State: on
  Learn: ❌ off

  Guides: 2 active
  Domains: en.wikipedia.org, boe.es, www.boe.es
  Helpers: 1 present
  ⚠ Disabled: boe.es
  Run /api helpers to list them.

  /api on      enable api-guide + api-fetch
  /api learn   enable all four tools (adds api-learn + api-probe)
  /api off     disable all API tools
```

Covers toggle state, active guide count, the domain list, and helper health
(disabled helpers surface with a `⚠`). When `pi-lean-portal` and
`pi-lean-search` are also installed, the status bar shows three independent
glyphs: `● idle` (browser), `● searxng` (search), and `● api` (host — when
`/api` is on).

---

## Configuration (`settings.json`)

Host settings are read from `~/.pi/agent/settings.json` (global) and
`.pi/settings.json` (project-local, overrides global).

### `toolsetDefaults` (toolset on/off defaults)

Whether the API tools are enabled on fresh conversations. Read by the
`pi-tool-masking` library at restore time, between the chat-branch tier and
the toolset's packaged default:

```jsonc
{
  "toolsetDefaults": {
    "toolset-state:pi-lean-dimension.api": { "enabled": true },
    "toolset-state:pi-lean-dimension.api-learn": { "enabled": false }
  }
}
```

- Keys are the toolsets' `persistKey` values.
- Omit a key to use the packaged default (`api` defaults `true`; `api-learn`
  defaults `false`).
- The `api-learn` toolset `requires` `api`, so enabling learn cascades api on;
  disabling api cascades learn off.

### No other settings keys

There is no `host.*` settings block. The transport layer (per-domain undici
`Agent` with retry-on-429, redirect policy, timeouts, ETag/`Cache-Control`
caching) is configured internally; `apiHost` and operation paths live **in
the recipe frontmatter**, not in settings. Credentials are **not** stored in
`settings.json` — they live in the per-domain secrets store, provisioned via
`/api secrets` (see [Authentication & Secrets](#authentication--secrets)).

---

## Co-Installing with `pi-lean-portal`

> **Planned for a future release.** Portal integration is
> being developed on the `pi-lean-host-integration` branch (0.5.0-track
> code, continuously rebased onto this package branch). The projection and
> navigate-footer surfacing described below are what that track delivers.
> Host-side projection code is present but inert until portal ships the
> receiving global (`__piLeanPortalRegisterGuideProvider`).

Portal is fully optional. When co-installed, host registers a **projection**
of its user-authored `ApiGuide`s with portal's guide-source registry at load
time — recipe fields stripped, presentation fields kept — so they **surface
in the navigate footer** in browse mode (`/web on` + `/api on`), the same
reactive mechanism web guides use. Host→portal opt-in; portal never imports
host.

- **Host-first ordering.** When both a host guide and a web guide match a
  domain, the host guide surfaces first (API access is cheaper, more
  reliable, lower-context than browsing). Both still surface; you choose.
  Host guides surface only when `/api` is on; web guides only when `/web`
  is on. No suppression — partial-coverage APIs keep their web guide for the
  gaps the API doesn't cover.
- **The projection carries one extra field**, `kind: "web" | "api"` (default
  `"web"`), which portal consumes only for ordering and the footer `reason`
  string. No recipe-structured data (`apiHost`, `operations`, `pagination`,
  `auth`) ever crosses the boundary.

Host-only installs don't register and lose nothing — reactive surfacing is an
enhancement for co-installs, not a host-only requirement. The on-demand path
(`api-guide({domain})`) is fully functional without it.

---

## Tips & Best Practices

### `api-fetch` vs `web-fetch` vs `api-probe`

| Use `api-fetch` | Use `api-probe` | Use `web-fetch` (portal) |
|-----------------|-----------------|--------------------------|
| An API you've guided | Discovering shape before authoring a guide | A one-off unguided fetch against a known URL |
| Repeated/paginated pulls | Drafting an op block from a live endpoint | Reading docs to author a recipe |
| You want auth/pagination handled for you | You're in `/api learn` | Host-only with an undocumented API (last resort) |

`api-fetch` is the guided path — the guide is the product. It has no
ad-hoc bare-fetch mode on purpose: that would recreate the exact mistakes
(hand-rolled auth, no pagination) the tool exists to prevent. The escape
hatches are `api-learn` (write a guide, then execute through it) and
`web-fetch` (portal) for a one-off.

### Authoring discipline

- Keep the prose body concise — it orients the agent; the frontmatter is the
  executable contract.
- Cite the source for every operation (docs URL or working example). `api-probe`
  surfaces evidence, not authority — confirm the shape against the docs.
- Fill `verified:` when you verify; it's defaulted to today, not enforced.
- Use `description:` when a domain has multiple guides — it's the primary
  disambiguation signal.

### `gatherAll` ceilings

A misconfigured `gatherAll` against a 100k-item paginator is a self-DoS. Set
`gatherAllMax` per-guide (or per-op) to the endpoint's real ceiling when you
know it. The global fallback (`1000`) bounds undeclared guides.

---

## Authentication & Secrets

Many read APIs authenticate with a static key (`X-Api-Key`, `Authorization:
Bearer`, or a `?key=` query param). pi-lean-host supports these end-to-end
without the credential ever appearing in the agent's context — a guide
**declares the secret by name**, you provision the value once, and `api-fetch`
injects it in code.

### A candid note on storage and threat model

The secrets store is **plaintext JSON at rest** — mode `0600`, no encryption.
That matches pi's own posture for its credentials (an API key in
`settings.json` or the env). The threat this guards against is not another
process reading the file; it's accidental **transcript exfiltration**. You
provision a value once via `/api secrets`, it's written transcript-safely to
the store, and `api-fetch` injects it in code — the agent sees the name, not
 the value.

That containment is plugin discipline, not a vault. `read`/`cat` on the
store file is one tool-call from the agent, which runs with your privileges,
so nothing here is a hard guarantee. **That's why the real rule is: store
read-only keys.** Scope every credential to the smallest read surface it needs
(e.g. a GitHub fine-grained token with read-only `contents`). A leaked read
key is a data-exposure incident; a leaked write key is a takeover — and the
plugin is GET-only, so a read-only key is always enough for what it does.

### Guide-side: declare the name, never the value

In `guide.md`, set `auth.kind: static-key` and point at store secrets by name.
The value never lives in the guide (a real key committed there would be one
`cat` from the agent's context).

```yaml
auth:
  kind: static-key
  secretRefs:
    x-cg-demo-api-key: api_key   # headerName: secretName
  requires: [api_key]            # absent → api-fetch fails closed
# secretQueryRefs: { apikey: api_key }  # query-param injection (?key=)
# optional: [api_key]            # used if present, skipped if absent
```

- **`auth.secretRefs`** — `Record<headerName, secretName>`: inject the store
  value into that request header.
- **`auth.secretQueryRefs`** — `Record<paramName, secretName>`: inject the
  store value as that query param.
- **`auth.requires`** — names the guide **hard-requires**. If one is absent
  from the store, `api-fetch` **fails closed before the request** — no silent
  unauthenticated fetch that could return partial data the agent mistakes for
  complete.
- **`auth.optional`** — names usable-if-present. Absent → `api-fetch` proceeds
  unauthenticated (e.g. GitHub: 60 req/hr unauth, 5000 with a token); present
  → injected like a required secret.
- **`auth.headers`** stays **literal-only** (demo keys, committed rate-limit
  tokens) — it is not the path for real credentials.

### Provisioning

```text
/api secrets                          list stored domains + secret names (names only)
/api secrets <domain>                 view + provision for a guide (prompts the declared names)
/api secrets <domain> <name>          set a single secret (manual escape valve)
/api secrets <domain> --delete        delete all secrets for a domain (confirm)
/api secrets <domain> <name> --delete delete a single secret
```

Provisioning is interactive (`ctx.ui` dialogs — the value is captured
**transcript-safely** and written straight to the store, never returned). On
headless hosts there is no dialog, so `/api secrets` prints the direct
file-write instructions instead — write the `0600` file yourself before pi
starts (a one-line `install -m 600` + `cat >` step).

Secrets persist at `~/.pi/agent/pi-lean-host/secrets/<domain>.json` (mode
`0600`). **Only names are ever listed** — values never leave the store.

### The status footer

Every `api-guide` / `api-fetch` result on an auth-bearing guide (`secretRefs`
or `secretQueryRefs`) ends with a `🔑 auth:` line — `ok`, `requires <name>
— not provisioned`, or an optional state — showing name and presence only,
never the value, so it's safe anywhere it renders.

### Authoring keyed guides

`api-probe` accepts an inline `auth` block (injection fields only) plus a
`domain` selector, so you can prove a keyed shape before writing the guide —
a store miss reports the name and fetches unauthenticated (authoring is
human-in-the-loop, not fail-closed). One of the keyed recipes in caritas is a
better starting template than `boe.es` for your first keyed guide — see
caritas's `CONTRIBUTING.md`.

## Security & Scope

### SSRF guard (server-supplied URLs only)

Host guards only the one URL path that earns it: `paginate`'s `nextLink`
style, where the next URL comes from the **remote API's response body** — a
URL neither you nor the agent chose. `ssrfGuard()` (a minimal `core/ssrf-guard.ts`,
no deps, no portal import) blocks loopback, private RFC1918 ranges, and cloud
metadata endpoints (`169.254.169.254`, `metadata.google.internal`,
`100.100.100.200`) on that server-supplied `nextUrl` before it is followed.

Agent-supplied URLs are **not** guarded. `restGet` assembles a URL from
`apiHost` + `operation.path` + query params — all agent- or user-directed.
The agent runs on your own machine with your own privileges and has `bash`,
`read`, and `write` over the filesystem; blocking `http://169.254.169.254/`
on `restGet` while `curl` is one tool-call away is a sieve with one hole
patched. With keyed auth shipped, the guard is now **load-bearing**: a server-supplied
`nextUrl` to an internal host would leak the attached `Authorization` header,
and any keyed `restGet`/`paginate` that redirects is forced through the
guarded loop — with injected secrets stripped on a cross-domain hop — so the
channel stays closed.

### v1 scope (what it is not)

- **GET-read only.** No mutation helper. Add one only when a real *retrieval*
  guide needs it (e.g. a search-then-fetch POST), behind a real auth-review
  gate.
- **Static-key auth only.** `auth.kind: static-key` is realized (store-backed
  header/query-param secrets, `requires`/`optional`); `oauth2` and cookie-login
  stay deferred. Values live in the `0600` secrets store, never in a guide —
  see [Authentication & Secrets](#authentication--secrets).
- **Bundled recipes are inert.** Nothing the package ships executes until you
  place it in `~/.pi/agent/pi-lean-host/` and opt in.
- **No inferred-link discovery.** Declared links only in v1; inference is v2.
- **No guide suppression.** Both guide kinds surface by domain match when
  their toggle is on; host-first is a preference, not suppression.

### Mission

`pi-lean-host` is a navigation and information-retrieval aide. It exists to
help an agent obtain information from structured APIs with as little friction
as possible — not to author content or automate online actions. Features
whose primary value is creating, mutating, or bot-automating will not be
added, even when technically feasible, unless they serve retrieval. The
local-helper escape hatch means a capable user *can* build bots on their own
machine; the package does not aim to make that easy.

---

> `pi-lean-host` is part of the
> [pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)
> web-tools suite. For the security model behind the secrets store (the
> two-threat model and the output-channel audit), see
> [Authentication & Secrets](#authentication--secrets). For the helper
> escape-valve policy and the 23-recipe spread, see
> [`docs/design/api-helper-escape-valve.md`](docs/design/api-helper-escape-valve.md).
>
> License: AGPL-3.0-only
