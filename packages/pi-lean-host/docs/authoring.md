# Authoring API Guides (pi-lean-host)

> The complete authoring reference for `pi-lean-host` API guides: the recipe
> schema (field reference), pagination styles, response shapes, local user
> helpers, and the `api-learn` / `api-probe` / `api-scaffold` tool loop.
> For install, the `/api` toggle, secrets provisioning, and the security
> model, see the [README](../README.md).

All authoring tools require `/api learn` — the explicit authoring opt-in,
mirroring `/web learn`.

## The authoring loop

**Auth-gated API? Handle credentials first.** For an OAuth2-gated provider,
start with `/api bootstrap oauth <domain> <spec>` — it injects a research
brief into the session (auto-enabling learn), the agent researches the
provider and calls `oauth-mint`, and you confirm at the prompts (the human is
the trust root for the secret-bearing endpoint). For static-key APIs,
`/api secrets <domain>` provisions the secret names the guide declares before
you verify (see the README's
[Authentication & Secrets](../README.md#authentication--secrets)). Then
author as below.

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

## Guide Recipes (the `recipe` block)

A guide is one markdown file: YAML frontmatter carries the structured recipe
(the executable contract), and a prose body carries orientation for the
agent (advisory). `api-fetch` reads the recipe slice and executes against it;
`api-guide` reads the detail slice for introspection. **The prose is
advisory, the frontmatter is authoritative.**

### File shape

A `guide.md` opens with a `---`-delimited YAML frontmatter block and
closes it with a second `---`; the prose body follows. An operation can
override the guide-level `pagination` / `responseShape` with its own block
in the frontmatter.

The fastest way to a first guide is to let the tools draft it:
`api-learn({domain, new: true})` returns a fail-closed starter template,
`api-probe` drafts real op blocks from a live endpoint — fill the
placeholders, then save with `api-learn`. For
**complete worked recipes** (real endpoints, `verified:` provenance,
auth-in-place, helper examples), see the caritas recipe library
(see the README's [Bundled Reference Recipes](../README.md#bundled-reference-recipes))
and copy a domain folder that matches your target.

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
| `verified` | guide | creation date | drift signal — **defaulted, not enforced**; stamped on success by `/api verify` |
| `schemaVersion` | guide | `0` (floor) | breaking-change detection — stamped on save by `api-learn`; a stale guide (`< current`) gets a non-blocking `⚠` warning in `api-guide`/`api-fetch`, **never a gate** |
| `gatherAllMax` | guide / op | `1000` | `gatherAll` ceiling; an op can override |
| `auth.kind` | guide | `none` | `none` \| `static-key` (store-backed header/query secrets) \| `oauth2` (client_credentials + authorization_code token flows) |
| `auth.headers` | guide | — | literal extra headers merged into every request (e.g. X-Api-Key: DEMO_KEY) — **literal values only**, never the path for real credentials |
| `auth.secretRefs` | guide | — | `Record<headerName, SecretRef>` — store-backed header injection (`static-key` + `oauth2`). Each ref is `{ secret, prefix?, optional? }`: `secret` is the store name, `prefix` is prepended to the stored value at resolution time (e.g. `"Bearer "`), `optional: true` → absent secret proceeds unauthenticated instead of failing closed |
| `auth.secretQueryRefs` | guide | — | `Record<paramName, SecretRef>` — store-backed query-param injection (`static-key`); a param name colliding with any op's `params` map is a parse error |
| `auth.grant` | guide | required (`oauth2`) | `client_credentials` \| `authorization_code` |
| `auth.tokenUrl` | guide | required (`oauth2`) | token endpoint (the only non-GET request host makes) |
| `auth.clientId` / `auth.clientSecret` | guide | required / grant-dependent | `SecretRef`s resolving from the secrets store — per-user, never shipped in a guide. `clientSecret` is parser-required for `client_credentials` and forbidden for `authorization_code` (PKCE public clients have none) |
| `auth.scopes` | guide | — | static scope list declared in the guide (`oauth2`) — no runtime picker |
| `auth.paramStyle` | guide | `bearer-header` | `bearer-header` \| `query` (sends `?access_token=…`, RFC 6750 §2.3) |
| `auth.tokenEndpointAuthMethod` | guide | `client_secret_post` | `client_secret_basic` \| `client_secret_post` \| `none` — how the client authenticates at the token endpoint |
| `auth.authorizeUrl` / `auth.revokeUrl` | guide | — | `authorizeUrl` is auth-code-only (parser-enforced present iff `grant: authorization_code`); `revokeUrl` is an optional revocation endpoint |
| `pagination.style` | guide / op | required when `via: paginate` | `offset-limit` \| `nextLink` \| `cursor` \| `page` \| `resumptionToken` \| `tokenBag` |
| `pagination.itemsPath` | guide / op | — | JSON path to the items array in the body |
| `pagination.totalCountPath` | guide / op | — | optional, any style → server-reported total surfaced as `serverTotal` / `server total: N` |
| `pagination.hasMorePath` | guide / op | — | optional, any style → JSON path to a boolean/numeric done-flag (Stripe's `has_more`); a resolved-falsy value stops a `gatherAll` walk cleanly (see [Has-more exhaustion](#has-more-exhaustion-hasmorepath)) |
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
| `operations[].requiresAnyOf` | op | — | `[param, ...]` — at least one of these params must be supplied (single group per op, v1; members are plain optional params — not `required: true`, not `default`-bearing: both rejected at parse) |
| `operations[].passthrough` | op | `false` | `true` forwards undeclared caller params onto the query string (for open-param APIs) |
| `operations[].parse` | op | inherits `responseShape` | op-level override of format/charset |
| `operations[].pagination` | op | inherits top-level | op-level override of pagination |

### Built-in helpers (the fixed executor set)

Three helpers, for v1. The agent never calls these directly — `api-fetch`
routes each operation through the one its `via` names:

- **`restGet`** — path templating, query params, Accept negotiation
  (JSON/XML), and auth injection for auth-bearing guides (static-key
  store-backed `secretRefs` / `secretQueryRefs`; `oauth2` Bearer tokens).
- **`paginate`** — wraps a list operation. The guide declares the style; the
  helper follows it. Returns `{items, totalFetched, serverTotal?, ceilingHit,
  urls, pages, params}` (plus `failedItems?` when per-item transforms fail)
  so the agent can stop or continue, plus a `gatherAll` flag for the "just
  get me everything" case with a hard ceiling.
- **`parseResponse`** — XML→JSON, declared per-endpoint (charset decoding happens in the transport).
  Agents mangle encodings constantly; fix it once here.

`restPost`/mutations are **not** in scope for v1 — the target APIs are
overwhelmingly GET-read.

### Pagination styles

`paginate` follows the style declared in the recipe. Six styles cover the
patterns the recipe library (caritas) pressure-tested:

| Style | What it sends | Key fields |
|-------|---------------|------------|
| `offset-limit` | absolute offset + page size | `pageParam`, `pageSizeParam`, `pageSize`, `base`, `itemsPath` |
| `page` | 1-based page number + page size | same fields as `offset-limit` (semantic difference only) |
| `nextLink` | follows a URL from the response body | `nextLinkPath`, `itemsPath` — the **only** SSRF-guarded path (see the README's [Security & Scope](../README.md#security--scope)) |
| `cursor` | echoes an opaque cursor query param | `cursorParam`, `cursorPath`, `itemsPath`, plus optional `pageSizeParam`/`pageSize` — page size resolves caller value → op param `default` → `pageSize` → **omitted** (server default applies, unlike offset-limit's 50 fallback) |
| `resumptionToken` | OAI-PMH opaque single-token cursor | `tokenParam`, `tokenPath`, `itemsPath` |
| `tokenBag` | Wikimedia-style multi-key continuation dict | `continuationParams[]`, `itemsPath` |

`totalCountPath` is optional on any style — a JSON path to the server's
reported total, surfaced as `serverTotal` in the `paginate` result and as
`server total: N` / `remaining: …` in the `api-fetch` footer. Omit it when
the API exposes no total. The same style-agnostic optionality applies to
`hasMorePath` — a JSON path to the server's done-flag (see the next
section).

#### Has-more exhaustion (`hasMorePath`)

`hasMorePath` is optional on any style — a JSON path to a boolean/numeric
"more pages" flag. Its canonical shape is Stripe's list envelope, which
pairs a derived cursor with an explicit flag and **no cursor field that
ever goes absent**:

```yaml
pagination:
  style: cursor
  itemsPath: data
  cursorParam: starting_after
  cursorPath: "data[-1].id"
  hasMorePath: has_more
```

Without a stop-condition field, a walk over an always-present cursor (or one
derived from the last item) only ends via the API's own past-the-end behavior
or the `gatherAllMax` ceiling — surfacing a false-alarm `⚠ Ceiling reached`
on a complete list. `hasMorePath` is the clean stop for that family: after a
page's items are collected, the flag is resolved against the page body and a
**resolved falsy** value (`false`, `0`, `""`, `null`) stops the walk cleanly
(no ⚠, no ceilingHit). The contract is plain truthiness, deliberately with
**no string coercion** — the string `"false"` is truthy in JS and therefore
advances. Don't author against APIs that serve the flag as a capitalized or
string-typed value (`<has_more>False</has_more>`, `"has_more": "false"`):
they walk to the ceiling with the false-alarm ⚠. XML is mostly covered —
the repo's XML parser converts lowercase `<has_more>false</has_more>` to
real boolean `false` (only capitalized variants stay strings).

The exhaustion rules, precisely:

- **`undefined` never stops.** If the field is absent or the path misses
  (typo'd), the walk continues under the pre-existing exhaustion semantics
  (empty page / absent cursor) — a typo'd `hasMorePath` degrades to the
  old behavior, never to a silent one-page truncation. Same for an API
  that omits the flag on the final page — don't author against one without
  testing it.
- **Empty final page wins.** The flag is only consulted on pages that
  produced items; a page with an empty `itemsPath` array exits via the
  empty-page rule before the flag is read.
- **Ceiling wins on the same page.** If the ceiling and a falsy flag fire
  together, `ceilingHit: true` is reported — the run genuinely was cut
  short. A final page that exactly fills the ceiling reports `ceilingHit`
  even with the done-flag false (pre-existing ceiling semantics).
- **`gatherAll` walks only.** Single-page ops break after page 1
  regardless — don't expect the flag to gate a single read.
- **Offset/page styles benefit most.** Those styles have no cursor-based
  exhaustion at all (the loop walks until the ceiling), so `hasMorePath` is
  the *only* clean stop condition for a `gatherAll` walk over an offset or
  page-numbered API that exposes a done-flag.

Not expressible: equality-with-sent stop conditions (Solr `cursorMark`'s
"stop when the returned cursor equals the one we sent") — that stays a
documented upgrade path (`stopWhen`), not this field. Solr-shaped guides:
`cursorMark` sends no boolean flag; its exhaustion is `numFound` vs.
docs-fetched — don't author Solr-shaped guides against `hasMorePath`.

Pagination blocks are **key-allowlisted per style**: only the keys listed
for the style above (plus `totalCountPath` and `hasMorePath`) are accepted.
An unknown key —
e.g. a `itemPath` typo or a `cursorPath` on a `nextLink` op — is a parse
error naming the offender and the style's valid keys, never a silent
single-page at runtime.

#### Path syntax (dot-splitting and the quoted-bracket escape hatch)

Path fields (`itemsPath`, `nextLinkPath`, `cursorPath`, `tokenPath`,
`totalCountPath`, `hasMorePath`) are dot-delimited: `data.items`,
`resultados[0].campo`, and
numeric indexes (`items[2].id`). Negative indexes address from the end —
`results[-1].id` is the last item's `id` (the derived-id cursor pattern); an
out-of-bounds negative is a clean miss (pagination terminates) and `[-0]` is
malformed. When the API's
key itself contains a dot — OData's `@odata.nextLink` / `@iot.nextLink` /
`@odata.count` family is the common case — the dot is part of the key name,
not a separator. Address it with a quoted bracket segment, which is treated
as one atomic key: `nextLinkPath: "['@odata.nextLink']"` (single or double
quotes both work). The unquoted form `@odata.nextLink` splits at the dot and
silently misses — a miss resolves to nothing and pagination terminates after
page 1, so always quote these keys.

Two syntax limits, by design: a quoted segment's content may not contain
`]` or a quote character — either ends the segment, so `['a]b']` and
`['a'b']` are malformed (a key containing `]` or a quote cannot be
addressed; note the pre-atomic-tokenizer resolver accidentally resolved
`['a]b']` as key `a]b` — that is no longer the case, it is a clean miss
now). And the numeric-continuation caveat: `cursor` and `resumptionToken`
paths coerce numeric values to strings, so an API that uses `0` as an
**end marker** (legacy Twitter-style `next_cursor: 0`) walks to the
`gatherAllMax` ceiling and surfaces the `⚠ Ceiling reached` warning for a
complete list — against such APIs, don't use `cursorPath` for the
end-marker field, or treat the ceiling signal as normal completion.

One declaration rule for sorted keyset walks (the derived-id family): a
walk that feeds an item field back as a cursor is only stable if every page
sorts identically on that field — and the executor serializes **only the
params declared on the op**. An undeclared sort param is silently dropped
and the API's own default sort applies, which turns the walk into a moving
newest-items feed that re-reads rows (valid-shaped, wrong-meaning — page 1
looks fine under any sort, so only a page-2+ non-overlap check catches it).
Declare the sort params on the op with their stable-walk defaults — e.g.
an `id`-keyed walk on an API whose sort params are named `order_by`/`order`
and whose default order is newest-first would declare both with defaults
`id` and `asc`.

`pagination` and `responseShape` are top-level defaults; an individual
operation overrides them with its own block.

### Response shapes (`parseResponse`)

Agents mangle encodings constantly; `parseResponse` fixes it once. Declared
per-guide (top-level `responseShape`) and overridable per-op (`parse:`):

- `format: json | xml | text` — XML is converted to JSON via `fast-xml-parser`; `text` is raw passthrough.
- `charset: utf-8 | <IANA name>` — the transport decodes using the response's Content-Type charset, falling back to this value when the header omits one (essential for Latin-1 / ISO-8859-1 APIs that serve bytes without a charset parameter). An explicit header charset always wins.
- `accept` (request-side, on each operation) is declared **independently**
  from `responseShape.format` (response-side) — they usually match but an API
  may return XML regardless of `Accept`, so they're separate fields.

### Recipe drift

A prose guide degrades gracefully; a declarative recipe with a wrong endpoint
fails **hard**. v1 treats drift as a signal the agent reads, not a gate the
loader enforces:

- The `verified` frontmatter date records when a guide was last verified
  against the live API (defaulted to creation date, **never enforced**). It's
  rendered in the guide-detail footer alongside the current date — the agent
  reads both and judges. `/api verify <domain>` runs every runnable op
  against the live API and stamps `verified` on success (strict: any
  runnable-op failure → no stamp; skipped ops named in the report; `--force`
  is human-typed only, no agent tool surface).
- The **live HTTP response is the actual drift signal.** A 401 on a no-auth
  guide, a 404 on a pinned path, a changed response shape — the agent reads
  those directly. The `verified` date is predictive; the response is actual.

---

## Local user helpers

For sites that need a computed signature, a strange date transform, or a
custom auth flow a declarative recipe can't express — one local user helper
per guide:

- **Location:** `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/helper.ts`
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
Authoring: scaffold a starter `helper.ts` stub via `api-scaffold({domain, helper: true})` (writes to the staged `/tmp` dir — never the guides dir), uncomment the export you need, then save via `api-learn({domain, dir})`. Edit a staged helper the same way; avoid hand-editing the file in the guides dir directly.

---

## Static-key auth in the guide

In `guide.md`, set `auth.kind: static-key` and point at store secrets by name.
The value never lives in the guide (a real key committed there would be one
`cat` from the agent's context).

```yaml
auth:
  kind: static-key
  secretRefs:
    x-cg-demo-api-key:
      secret: api_key            # store name (required — this IS the ref)
    # Authorization:             # scheme-style header (GitHub/GitLab) —
    #   secret: github_token     #   the store holds the RAW token; the
    #   prefix: "Bearer "        #   guide declares how it is presented
  secretQueryRefs:
    apikey:
      secret: api_key            # query-param injection (?key=)
    user_key:
      secret: user_key
      optional: true             # used if present, skipped if absent
```

Each ref is `{ secret, prefix?, optional? }` — availability and prefix are
properties of the ref itself, not separate rosters:

- **`auth.secretRefs`** — `Record<headerName, SecretRef>`: inject the store
  value into that request header. A ref without `optional: true` is
  **hard-required**: absent from the store → `api-fetch` **fails closed
  before the request** — no silent unauthenticated fetch that could return
  partial data the agent mistakes for complete.
- **`prefix`** — prepend a scheme prefix to the resolved value for that
  header (e.g. `Authorization: "Bearer "`). The store holds the **raw
  credential**; the ref declares how it is presented. Absent = verbatim value.
- **`optional: true`** — usable-if-present. Absent → `api-fetch` proceeds
  unauthenticated (e.g. GitHub: 60 req/hr unauth, 5000 with a token);
  present → injected like a required secret.
- **`auth.secretQueryRefs`** — `Record<paramName, SecretRef>`: inject the
  store value as that query param. A param name colliding with any op's
  `params` map is a parse error.
- **`auth.headers`** stays **literal-only** (demo keys, committed rate-limit
  tokens) — it is not the path for real credentials.

Migrating a guide from the old flat shape (`requires`/`optional` rosters,
`headerPrefixes` map, bare-string refs)? See
[docs/migration-v1.md](migration-v1.md).

### Authoring keyed guides with `api-probe`

`api-probe` accepts an inline `auth` block (injection fields only) plus a
`domain` selector, so you can prove a keyed shape before writing the guide —
a store miss reports the name and fetches unauthenticated (authoring is
human-in-the-loop, not fail-closed). Probe is pure shape discovery — for
the pre-probe "what credentials exist for this domain" check, the agent
calls `api-store` (learn-gated).

---

## The authoring tools in detail

### `api-learn` — Author / Update a Guide

```text
api-learn domain="arxiv.org" new=true           → stages a fresh placeholder template to /tmp/pi-lean-host/arxiv.org/guide.md
api-learn domain="arxiv.org"                    → fetches an existing guide's raw recipe + siblings into the staged dir
api-learn domain="arxiv.org" dir="/tmp/pi-lean-host/arxiv.org"  → validates + mirror-saves the staged dir to disk
```

- `{domain, new: true}` → a fresh starter template with `domains: [<domain>]`
  **staged to `/tmp/pi-lean-host/<domain>/guide.md`**. Only `domains` is real;
  the other fields are `<placeholder>` values that **fail closed**, so a
  pasted template cannot save until you fill it in.
- `{domain}` (no `dir`) → fetch the current raw recipe of an existing guide
  **and its present siblings** (`helper.ts`, `verify.json`) into the staged
  dir (surfacing the guide's `dirName` so you know which folder it lives in);
  a disambiguation menu if several guides claim the domain.
- Every staged pull (template or fetched recipe) is prepended with the
  authoring manual — the field reference + defaults + semantics the author
  needs at the moment of authoring.
- `{domain, dir}` → reads every staged file, validates the guide **before**
  touching disk, then **mirror-saves** the staged dir to
  `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/` — the folder is
  derived from the guide's own `shortName`, not the `domain` arg, so a
  re-save naturally lands back in the same folder. Present staged files
  overwrite their guides-dir counterparts; a sibling present in the guides dir
  but absent from the staged dir would be deleted, so save **refuses and
  names the doomed files** until you re-call with `confirmDeletions: true`
  (that flag is discovered only via the refusal message). A fail-closed
  guard refuses to overwrite an existing `guide.md` whose `shortName`
  differs from the incoming guide — a slug collision (two shortNames that
  slug to the same folder, e.g. `api_dev_full` / `api-dev-full`); a same-`shortName`
  save is a legitimate update. On a structural error it names the field, the
  expected shape, and what was found — the file on disk is left untouched (no
  half-written guide). Requires `/api learn`.

The working copy is staged at `/tmp/pi-lean-host/<domain>/` (`/tmp`
self-cleans, so drafts don't accumulate) — fetch/template calls write the
draft there and you edit that file between saves; saving reads the staged dir
and publishes to the guides dir. No session-held state, no `/api save`.

### `api-probe` — Discover an Endpoint's Shape

Agent-driven shape discovery for the authoring loop. Fetches a not-yet-guided
endpoint over the real transport (same UA, charset, retry, and ETag handling
as `api-fetch` — the sanctioned way to reach even WAF'd hosts), summarizes the
JSON shape, and emits a **draft YAML operation block** to paste into a recipe.
It only **suggests** — it never writes the guide, and a draft still needs
confirming against the provider's docs (probe surfaces evidence, not
authority).

You won't call this tool yourself — the agent does, during authoring. Its
full parameter contract (version-walk on 404, inline auth block, domain
override) lives in the tool description and the authoring manual `api-learn`
prepends to staged drafts, not here.

### `api-scaffold` — Bootstrap `verify.json` / `helper.ts`

```text
api-scaffold domain="arxiv.org" verify=true   → writes a starter verify.json with "__FILL_ME__" sentinels to /tmp/pi-lean-host/<slug(shortName)>/verify.json
api-scaffold domain="arxiv.org" helper=true  → writes a commented-out helper.ts stub to /tmp/pi-lean-host/<slug(shortName)>/helper.ts
```

Bootstrap tool for the two artifacts the authoring loop needs but that
`api-learn` can't draft from the recipe alone:

- `{domain, verify: true}` → for every op with unsatisfiable params (path
  `{token}`, required query with no default, `requiresAnyOf` group), writes
  `{ "<opName>": { "<param>": "__FILL_ME__" } }` to the staged
  `/tmp/pi-lean-host/<slug(shortName)>/verify.json`. `"__FILL_ME__"` is a
  sentinel: treated as unsupplied, so the op skips until you replace it. If a
  `verify.json` exists in the guides dir, its real values are **additively
  merged** (preserved; sentinels added only for newly-unsatisfiable params).
- `{domain, helper: true}` → writes a commented-out `helper.ts` stub (both
  `default` and `transform` exports, with doc comments) to the same staged
  dir.
- At least one of `verify`/`helper` must be `true`. The tool **never
  overwrites** an existing staged sibling — delete it from `/tmp` first, then
  re-call. Staging is keyed by `slug(shortName)` (same pattern as
  `api-learn`), so a scaffolded `verify.json`/`helper.ts` lands in the same
  dir `api-learn` saves from. Save the guide **first**, then scaffold —
  `api-scaffold` reads the saved guide. Requires `/api learn`.

---

## Authoring discipline

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

## Publishing to the shared recipe library

Guides you author live in your own `~/.pi/agent/pi-lean-host/api-guides/` and
are yours to keep. To contribute a recipe to the shared, live-verified
library instead, see the
[caritas `CONTRIBUTING.md`](https://github.com/coreyryanhanson/caritas/blob/main/api-guides/CONTRIBUTING.md) —
same schema, plus co-located endpoint-coverage tests, docs-citation
discipline, and per-recipe `verified:` provenance.
