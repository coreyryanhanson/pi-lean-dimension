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

> ⚠️ **Breaking change in 0.4.0 — guide folders are now keyed by `shortName`.**
> Each guide must live in a folder named `slug(shortName)` — its `shortName`
> lowercased, with non-alphanumeric runs replaced by `-` (e.g. `shortName:
> BOE` → folder `boe`). Guides still sitting in a `<domain>/` folder from 0.3.x
> are flagged **malformed** and won't load until you rename the folder to
> `slug(shortName)` and `/reload` — the startup warnings give the exact `mv`
> command. Hand the warnings to the agent; it will fix them for you.

<!-- TODO(0.5.0): remove this temporary breaking-change note once the 0.4.0 migration is settled. -->

> ⚠️ **Early release (0.4.0).** The API tools here work today, but this is a
> development preview. The recipe schema, tool surfaces, and guide format are
> still settling as we test more APIs to finalize the shape — **future
> compatibility is not guaranteed** until the package reaches lockstep with
> `pi-lean-dimension` 0.5.0. Guides authored against 0.3.x may need revision
> as the schema firms up.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [The Big Idea: Recipes, Not a Runtime](#the-big-idea-recipes-not-a-runtime)
3. [`/api` Command — API Toggle](#api-command--api-toggle)
4. [All 7 Tools](#all-7-tools)
5. [Authoring Your First Guide](#authoring-your-first-guide)
6. [Reference Recipes (caritas)](#reference-recipes-caritas)
7. [Configuration (`settings.json`)](#configuration-settingsjson)
8. [Co-Installing with `pi-lean-portal`](#co-installing-with-pi-lean-portal)
9. [Tips & Best Practices](#tips--best-practices)
10. [Authentication & Secrets](#authentication--secrets)
11. [Security & Scope](#security--scope)

---

## Quick Start

```bash
pi install npm:pi-lean-host
```

No browser binaries, no server, no setup wizard. The host tools are **enabled
by default** — you'll see:

> 📡 API tools enabled. /api learn to make api-learn + api-probe + api-scaffold + api-store + oauth-mint available.

From a fresh install you have no guides yet, so the next step is to get one:

- **Author one** — see [Authoring Your First Guide](#authoring-your-first-guide)
  for the end-to-end workflow, including auth-gated APIs. The complete
  authoring manual (field reference, pagination styles, helper contracts)
  lives in [docs/authoring.md](docs/authoring.md).
- **Or copy a reference recipe** (see
  [Reference Recipes (caritas)](#reference-recipes-caritas)) into
  `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/` — it loads
  immediately.

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
  reviewed tool + fixed helpers, and those mistakes disappear at the source.
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
| Local user helpers | `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/helper.ts` | you, or the agent in `/api learn` | no | user-owned |
| Bundled recipes | `caritas` repo (`api-guides/<slug(shortName)>/`) | maintainers | no — [Reference Recipes](#reference-recipes-caritas) | **inert — never auto-executed** |

Built-in helpers cover the common 90%. Local user helpers cover the weird 10%
(computed signatures, strange date transforms, custom auth).

---

## `/api` Command — API Toggle

| Command | Effect |
|---------|--------|
| `/api on` | **API access** — `api-guide` + `api-fetch` available. Authoring tools hidden. (Default for new sessions.) |
| `/api learn` | **API access + authoring** — adds `api-learn` + `api-probe` + `api-scaffold` + `api-store` + `oauth-mint` on top of `on`. The agent never authors guides unprompted — it must be in learn mode. |
| `/api off` | **All API tools hidden** — removes `api-*` from the agent's context to save tokens on sessions that aren't doing API work. |
| `/api` | Show current state and available sub-commands. |
| `/api status` | Detailed runtime status — toggle state, active guide count, domain list, and helper health (disabled helpers surface with a `⚠`). |
| `/api helpers` | List local user helpers (or `/api helpers <domain>` to view one's source). |
| `/api secrets [<domain> [<name>]]` | Manage stored API secrets — list, provision, delete (see [Authentication & Secrets](#authentication--secrets)). |
| `/api verify <domain> [guide] [--force]` | Run every runnable op against the live API and stamp `verified` on success — strict: any runnable-op failure → no stamp; skipped ops named in the report (see [Recipe drift](docs/authoring.md#recipe-drift)). |
| `/api delete <domain> [guide]` | Remove a guide directory and invalidate the guide-store cache — a human-typed recovery gesture (no agent tool surface); interactive confirm for a whole-domain delete. |
| `/api oauth <domain> …` | OAuth2 token management — `init` / mint / `--status` / `--refresh` / `--revoke` / `--code <code>` per token slot (human-typed; the agent's mint path is `oauth-mint`). `init` runs an interactive wizard (or headless flags — see `--help` for `--redirect-uri`, which must match the provider app registration) and finishes a paste-based auth-code flow via `/api oauth init <domain> … --code <code>`. |
| `/api bootstrap oauth <domain> <spec>` | Agent-driven OAuth2 bootstrap — validates args, auto-enables learn when off, injects a research brief into the session, and exits; the agent then researches the provider and calls `oauth-mint` (the human is the trust root for the secret-bearing endpoint). Refused headless. |

### Persistence

Toggle state persists via the [`pi-tool-masking`](https://github.com/coreyryanhanson/pi-tool-masking/)
library (`persistKey: toolset-state:pi-lean-dimension.api`), surviving
`/reload`, `/resume`, `/fork`, and `/tree` navigation. A fresh conversation
starts from the `toolsetDefaults` block in merged Pi settings (see
[Configuration](#configuration-settingsjson)), falling back to the packaged
defaults.

The status bar shows an `api` glyph (independent of the `browser`/`search`
slots). It reads `● api` when `/api` is on (colored to reflect learn state)
and `○ api` when off.

---

## All 7 Tools

`pi-lean-host` registers 7 tools. `api-guide` and `api-fetch` are available
under `/api on`; `api-learn`, `api-probe`, `api-scaffold`, `api-store`, and
`oauth-mint` are added under `/api learn`.

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
`operation` across them, and executes it against the matching guide.
Exactly one hit executes; zero hits lists the ops from all matching guides
(a multi-guide domain — each guide in its own directory — so you can pick);
an op name appearing in ≥2 guides is an ambiguous collision the guide
authors must fix (re-author via `api-learn` to rename). The agent never sees a
URL, never sees a header, never sees the auth scheme. Output is an inline
preview (~4000 chars) with larger responses spilled to a temp file under
`/tmp/pi-lean-host/` (overridable via `PI_HOST_TEMP_DIR`) — `read` it with
offset/limit for specific sections.

When no guide exists for the domain, the call **fails informatively** and
points at `api-guide({})` (to list guided domains) and `api-learn` (to author
one) — turning a failed execute into a discovery moment in one round-trip.

### 3. `api-learn` — Author / Update a Guide (local write)

```text
api-learn domain="arxiv.org" new=true           → stages a fresh placeholder template to /tmp/pi-lean-host/arxiv.org/guide.md
api-learn domain="arxiv.org"                    → fetches an existing guide's raw recipe + siblings into the staged dir
api-learn domain="arxiv.org" dir="/tmp/pi-lean-host/arxiv.org"  → validates + mirror-saves the staged dir to disk
```

The working copy is staged under `/tmp/pi-lean-host/` (`/tmp`
self-cleans, so drafts don't accumulate; `<domain>/` for starter
templates (`new: true`), `<slug(shortName)>/` for fetched recipes) —
a fresh fail-closed starter
template, an existing guide's raw recipe + siblings for
direct editing, or a validated mirror-save of the staged dir into
`~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/`. Every staged pull
is prepended with the authoring manual.
Full staging, deletion-gate, and slug-collision semantics:
[docs/authoring.md](docs/authoring.md#the-authoring-tools-in-detail).

### 4. `api-probe` — Discover an Endpoint's Shape (network read, exploratory)

Agent-driven shape discovery for the authoring loop. Fetches a not-yet-guided
endpoint over the real transport (same UA, charset, retry, and ETag handling
as `api-fetch` — the sanctioned way to reach even WAF'd hosts), summarizes the
JSON shape, and emits a **draft YAML operation block** to paste into a recipe.
It only **suggests** — it never writes the guide, and a draft still needs
confirming against the provider's docs (probe surfaces evidence, not
authority).

### 5. `api-scaffold` — Bootstrap `verify.json` / `helper.ts` (local write)

```text
api-scaffold domain="arxiv.org" verify=true   → writes a starter verify.json with "__FILL_ME__" sentinels to /tmp/pi-lean-host/<slug(shortName)>/verify.json
api-scaffold domain="arxiv.org" helper=true  → writes a commented-out helper.ts stub to /tmp/pi-lean-host/<slug(shortName)>/helper.ts
```

Bootstrap tool for the two artifacts the authoring loop needs but that
`api-learn` can't draft from the recipe alone: a `verify.json` with
`"__FILL_ME__"` sentinels for every op with unsatisfiable params (sentinels
skip until you replace them; existing real values merge additively) and a
commented-out `helper.ts` stub. Both staged to `/tmp` — never the guides
dir, never overwriting an existing staged sibling. Save the guide **first**,
then scaffold.

### 6. `api-store` — Inspect Both Credential Stores (local read, learn-gated)

```text
api-store → orphan view: unscoped secret domains + token domains with no guide
api-store domain="api.github.com" → combined secrets + tokens report for the domain
```

Read-only inspection of **both credential stores in one call** — the
agent-facing view of `/api secrets` + `/api oauth --status`. The authoring
question is never "show me tokens" in isolation; it is what credentials exist
for a domain, what's declared vs provisioned vs minted, what's expired, and
what needs minting next.

- Bare call → the authoring-bootstrap (orphan) view: unscoped secret domains
  and token domains with no guide. Token domains resolve through the same
  store-domain seam minting uses, so an `api.`-subdomain token maps to its
  parent's guides instead of false-positive as guideless.
- With `domain` (or `apiHost`, resolved the same way) → the combined
  per-domain report: provisioned/declared/gap secret names, token slots
  (issuer, granted scope, expiry, refreshable), and **declared-slot gaps** —
  "guide declares client_credentials via `tokenUrl`: no token minted" — the
  pointer to `oauth-mint` that replaces a trial-and-error 401.

Metadata only: `accessToken`/`refreshToken` are dropped at the collection
boundary and secret values never enter the tool — they can't appear in the
rendered text **or** the structured `details`. When a token's granted scope
wasn't echoed by the provider, the requested scopes render with an
"(assumed)" marker (RFC 6749 §5.1). Mint via `oauth-mint`; refresh/revoke
stay human-typed (`/api oauth`).

### 7. `oauth-mint` — Human-in-the-Loop OAuth2 Mint (network write, consented)

```text
oauth-mint domain="github.com" grant="authorization_code" tokenUrl="https://github.com/login/oauth/access_token" ... → prompts the human, then mints + stamps the token store
```

The learn-gated mint half of the agent-driven OAuth2 bootstrap. The agent
supplies researched params (grant, token/authorize URLs, scopes, client
credentials as **store NAMES**); the tool validates fail-closed, prechecks
the store names, then prompts the human — token-URL confirm (the human is
the trust root for the secret-bearing endpoint), a ✓/○ scopes checklist,
and a paste prompt for the redirect URL (which never enters the
transcript). Any cancel prints the two-call `/api oauth init <domain> …
--code` escape-hatch hint.

---

## Authoring Your First Guide

The simplest case — a public API with no auth — end to end:

1. **`/api learn`** — enable the authoring tools.
2. **Ask your agent to author a guide** — point it at the API's
   documentation (a saved spec document or an online docs URL) and say
   which endpoints you want. The agent stages a starter template
   (`api-learn({domain, new: true})`), fills in the recipe — `apiHost`,
   one operation to start, no pagination needed for a single flat
   endpoint — and confirms every op block against the spec you supplied.
   For an endpoint that isn't documented, the agent calls `api-probe` on
   the live URL to draft the YAML op block for your review.
3. **Review and save** — the agent validates the draft and saves it to
   `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/guide.md`
   (via `api-learn({domain, dir: …})`).
4. **Use it** — from now on, just ask your agent for data from that API
   in plain language; it calls `api-fetch`, which discovers the guide by
   domain and handles URL construction, auth, and pagination. Then run
   `/api verify <your-domain>` to check every op against the live API — a
   passing run stamps `verified` on the guide.

Auth-gated API? Two additions, both handled before the guide will fetch
successfully:

- **Static key** — you provision the value once via `/api secrets <domain>`;
  the guide declares it by name with `auth.kind: static-key`. See
  [Authentication & Secrets](#authentication--secrets).
- **OAuth2** — `/api bootstrap oauth <domain> <spec>` injects a research
  brief and the agent drives `oauth-mint`; you confirm the token URL, tick
  the scopes, and paste the redirect URL back. See the `/api bootstrap` row
  in the [command table](#api-command--api-toggle).

The complete field reference, pagination styles, and helper contracts live
in [docs/authoring.md](docs/authoring.md).

---

## Reference Recipes (caritas)

The comprehensive recipe library lives in the
[**caritas**](https://github.com/coreyryanhanson/caritas) repo — real,
verified recipes spanning the no-auth **and keyed** axes, each with a
per-recipe `verified:`-date provenance and the perpetual drift disclaimer.
They are inert reference material: nothing executes until you copy a recipe
into your own `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/`
directory.

Host itself ships only a **synthetic axis-guide set** under `api-guides/` —
minimal coverage fixtures (no `verified:` date, no live endpoints) that keep
every guide-driven framework axis exercised via mocked transport. They are
framework fixtures for host's own tests, not recipes for you to copy
(membership pinned by `__tests__/axis-coverage.test.ts`).

The domains caritas covers (a discoverability index, may drift from the live
repo):

```text
arxiv                         ecb-data-portal               internet-archive              wayback-availability
boletin-oficial-del-estado    etherscan                     library-of-congress           wayback-cdx-server
coingecko                     federal-register              musicbrainz                   wikidata
data-gov                      gbif                          open-library                  wikimedia-action
datos-gob-es                  github                        pubmed-e-utilities            wikipedia-rest
deutsche-nationalbibliothek   gitlab                        usgs-earthquake
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
(e.g. `.../api-guides/wikipedia-rest`).

A recipe may carry `operation.helper: true` plus an accompanying `helper.ts`
in its domain subdir as a worked example. See caritas's `CONTRIBUTING.md`
for contributing a recipe to the library; for authoring one for yourself,
see [docs/authoring.md](docs/authoring.md).

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

There is no `host.*` settings block. The transport layer (per-domain undici
`Agent` with retry-on-429, redirect policy, timeouts, ETag/`Cache-Control`
caching) is configured internally; `apiHost` and operation paths live **in
the recipe frontmatter**, not in settings. Credentials are **not** stored in
`settings.json` — they live in the per-domain secrets store, provisioned via
`/api secrets` (see [Authentication & Secrets](#authentication--secrets)).

---

## Co-Installing with `pi-lean-portal`

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

`api-fetch` is the guided path — the guide is the product. It has no
ad-hoc bare-fetch mode on purpose: that would recreate the exact mistakes
the tool exists to prevent. The escape
hatches are `api-learn` (write a guide, then execute through it) and
`web-fetch` (portal) for a one-off.

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
process reading the file; it's accidental **transcript exfiltration**.

That containment is plugin discipline, not a vault. `read`/`cat` on the
store file is one tool-call from the agent, which runs with your privileges,
so nothing here is a hard guarantee. **That's why the real rule is: store
read-only keys.** Scope every credential to the smallest read surface it needs
(e.g. a GitHub fine-grained token with read-only `contents`). A leaked read
key is a data-exposure incident; a leaked write key is a takeover — and the
plugin is GET-only, so a read-only key is always enough for what it does.

### Guide-side: declare the name, never the value

In `guide.md`, set `auth.kind: static-key` and point at store secrets by name
— the value never lives in the guide (a real key committed there would be one
`cat` from the agent's context). The full guide-side YAML (`secretRefs` /
`secretQueryRefs`, `prefix`, `optional`, and the parser-enforced invariants)
is documented in
[docs/authoring.md](docs/authoring.md#static-key-auth-in-the-guide).

Migrating a guide from the old flat shape (`requires`/`optional` rosters,
`headerPrefixes` map, bare-string refs)? See
[docs/migration-v1.md](docs/migration-v1.md).

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
starts (a one-line `install -m 600` + `cat >` step). Secrets persist at
`~/.pi/agent/pi-lean-host/secrets/<domain>.json` (mode `0600`).

### The status footer

Every `api-guide` / `api-fetch` result on an auth-bearing guide (static-key
`secretRefs`/`secretQueryRefs`, or an `oauth2` token slot) ends with a
`🔑 auth:` line — `ok`, `requires <name> — not provisioned`, or an optional
state — showing name and presence only, never the value, so it's safe
anywhere it renders.

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
- **GET-read auth surface.** `auth.kind: static-key` (store-backed
  header/query-param secrets) and `auth.kind: oauth2` (`client_credentials`
  - paste-based `authorization_code`) are realized; cookie-login stays
  deferred. See [Authentication & Secrets](#authentication--secrets).
- **No inferred-link discovery.** Declared links only in v1; inference is v2.

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
> web-tools suite.
>
> License: AGPL-3.0-only
