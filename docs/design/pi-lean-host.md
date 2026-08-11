# pi-lean-host — Design Document

> High-level design for a domain-discoverable API recipe layer. Status:
> **implemented, pre-first-publish** — the helper surface is generalized
> across 15 no-auth bundled recipes (see [`api-helper-escape-valve.md`](./api-helper-escape-valve.md)
> for the per-recipe breakdown and the built-in vs local-helper classification);
> the code is live on this
> branch and bundled in `pi-lean-dimension`, with the first real `npm publish`
> targeting 0.5.0. (The 0.4.0 release was the `pi-tool-masking` migration for
> portal/search tool-enable/disable defaults — not a host feature release.)
> This document owns the *what* and *why*.

## The gap

Some sites are nearly unusable through agent-driven web browsing but expose a
clean, well-documented HTTP API. `https://www.boe.es/` is the canonical
example — hostile HTML, but `https://www.boe.es/datosabiertos/api/api.php` is
excellent when used correctly.

Today, an agent that needs such an API:

- reconstructs the endpoint shape, auth, and pagination from scratch every
  session (token-expensive, error-prone);
- gets auth schemes wrong repeatedly;
- paginates badly or not at all;
- mangles response encodings (XML, non-UTF-8 charsets);
- and, when it does figure it out, the working knowledge is lost next session.

The existing `web-guides` mechanism already solves the *prose* version of this
problem for browsing (`bot-detection`, `cookie-consent`, pagination patterns,
site-specific `.md` guides discovered by domain). `pi-lean-host` fills the
parallel gap for **structured API access**: a discoverable, declarative recipe
store that an agent accesses through a small set of managed tools, so the
knowledge is authored once and reused.

## Mission

`pi-lean-host` is a navigation and information-retrieval aide. It exists to
help an agent interface cleanly with structured APIs to *obtain* information
with as little friction as possible — not to author content or automate
online actions. Features whose primary value is creating, mutating, or
bot-automating will not be added to the package, even when
technically feasible, unless they serve retrieval. The local-helper escape
hatch means a capable user *can* build bots on their own machine; the
package does not aim to make that easy — and bundled recipes are inert
reference material, so nothing the package ships executes until the user
copies it into their own directory and opts in.

## Name

`pi-lean-host` — the npm namespace is already reserved. The pun holds twice:
Lorne is *The Host* of Pylea (Angel), and the tool talks to a remote *host*
via code instead of DOM. The package carries the pun; the tool name does not
have to (see Tool naming).

## Core decision: recipes, not a runtime

The single most important discipline: **only files the user places in
`~/.pi/agent/pi-lean-host/` execute.** The agent does not write TypeScript
against the API. A guide declares endpoints, auth, pagination, and response
shape; a managed tool executes the declared operation through a small set of
fixed helpers. Bundled recipes (in `packages/pi-lean-host/api-guides/` on
GitHub) are inert reference material — the loader never touches them. A user
adopts one by copying it (and any accompanying helper) into their own
directories; only then does it load and execute.

This decision exists to kill the two biggest risks before they exist:

1. **Arbitrary eval / egress safety.** Executable TS in a guide is a sandbox
   problem. Declarative recipes executed by a fixed tool are not — and
   because bundled recipes are inert, the only code that ever runs is code
   the user explicitly placed in their own directory.
2. **Recurring mistakes.** The reason agents keep getting the same API wrong
   is that *they are the ones writing the calls.* Move the call construction
   into a reviewed tool + fixed helpers, and the class of mistakes cannot
   recur — the agent never touches the auth header, never hand-rolls
   pagination, never picks the wrong Accept header.

The "executable TypeScript" instinct is legitimate *in one place*: local
user helpers for the weird sites that need a computed signature or a strange
date transform. These live in a user-owned directory, one helper per guide
alongside its guide, never in the npm tarball — sharing the *ownership*
half of the stealth-backend trust
model (user-owned, opt-in, not shipped), but **not** the *isolation* half.
This is a deliberately new isolation profile in the codebase: stealth
backends run as out-of-process Python subprocesses (a crash is caught by the
adapter; pi keeps running), whereas local helpers load via in-process
`import()` (no process boundary). See *Execution: `import()`* for the
residual that creates. The discipline line is not "the agent can't write
code"; it is about
**where the code lands and who opts in**: the agent may author a local helper,
but only in learn mode (`/api learn`), and only into the user-owned directory.
A user-authored guide references its guide's helper (one per guide directory);
`api-fetch` runs it. A bundled recipe may *show* a helper (an accompanying
`helper.ts` in its `api-guides/<dirName>/` subdir) as a worked example, but
it does not execute until the user copies the whole guide folder into their
own dir.

## Three tiers of code, separated by trust

| Tier | Where it lives | Who writes it | Ships in tarball? | Trust |
|------|----------------|---------------|-------------------|-------|
| Built-in helpers | package source | maintainers | yes | reviewed |
| Local user helpers | `~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts` | the user, or the agent in learn mode (`/api learn`) | no | user-owned |
| Bundled recipes | `packages/pi-lean-host/api-guides/<domain>/` in the repo (GitHub) | maintainers | no (reference material) | inert — never auto-executed |

Built-in helpers cover the common 90%. Local user helpers cover the weird 10%
(the computed-signature, strange-encoding, custom-auth cases). The trust
boundary is **where code lands and who opts in**, not a per-guide helper
restriction:

- A **bundled recipe** is inert reference material. It may carry an
  `operation.helper: true` field plus an accompanying `helper.ts` in its
  `api-guides/<domain>/` subdir as a worked example, but it does not execute
  until the user copies the whole domain folder into their own directory.
  The loader never reads `api-guides/`.
- A **user-authored guide** (the only kind that loads) may reference
  built-ins for the common case, or its own local helper for the weird case.

Only files under `~/.pi/agent/pi-lean-host/` load and execute. This is the
discipline line: nothing the package ships runs until the user places it in
their own directory and opts in.

### Escape-valve policy: resolved

The three-helper set (`restGet` / `paginate` / `parseResponse`) was derived
from `boe.es` and originally shipped as a hypothesis validated against that
one no-auth reference API. The no-auth generalization pressure-tested it across a 15-recipe
no-auth spread (axes: `nextLink`/JSON, XML/non-UTF-8, non-standard cursor
locations, header-based pagination, continue-token bags, GeoJSON, JSON-LD,
mixed field-naming, single-resource responses, non-Latin scripts, rate-limit
headers, boolean end-of-records signals, overloaded pagination signals,
query-param content negotiation, free dev-key headers). The durable line —
which quirks are **built-in** vs **local-helper** — is drawn per quirk class
in [`api-helper-escape-valve.md`](./api-helper-escape-valve.md), with the
recipe spread as evidence. The auth path (`auth.kind: none` only) remains the
axis least validated by v1; keyed auth is a separate track (see *Secrets
management*).

## The built-in helper set (lazy minimum, provisional)

The helpers earn their keep where agents fail repeatedly. Concretely, against
the boe.es shape:

- **`restGet`** — path templating, query params, Accept negotiation
  (JSON/XML), and auth injection *when a guide declares an auth strategy*
  (see *Secrets management*). The agent never sees the auth header. v1 ships
  only `auth.kind: none`, so no v1 guide declares a strategy — the dispatch
  exists as a seam, but the injection path is cold code until a keyed guide
  lands. A guide with no `auth` block (v1's BOE reference) skips auth
  entirely — no header.
- **`paginate`** — wraps a list operation. The guide declares the *style*
  (`offset-limit` | `nextLink` | `cursor` | `page` | `resumptionToken` | `tokenBag`);
  the helper follows it. This is the single biggest repeat-mistake, so it's
  the one worth building right. Returns `{items, next?, serverTotal?}` so the
  agent can stop or continue; a `gatherAll` flag for the "just get me
  everything" case with a hard ceiling (see *gatherAll ceiling*). When the
  guide declares a `totalCountPath` (see *Guide recipe schema*), the helper
  also extracts the server's reported total from the first page and returns
  it as `serverTotal`; the `api-fetch` footer prints `server total: N`
  (and `remaining: …` when more pages exist).
- **`parseResponse`** — XML→JSON, charset fixing, declared per-endpoint.
  Agents mangle encodings constantly; fix it once here.

That's it. Three helpers, for v1. `restPost`/`restPut`/mutations are **not**
in scope for v1 — the target APIs are overwhelmingly GET-read. Add a mutation
helper only when a real guide needs one, behind a real auth-review gate.

## The agent-facing tools

Four tools, split by side-effect boundary, symmetric with the `web-*`
family. The earlier one-tool design (arity-polymorphic `api-fetch` returning
catalog / guide detail / execute result) was a vestige of when host lived
under the `/web` toggle and minimizing the tool count mattered. With host as
an independent peer toggle, that constraint is gone, and the split lands on
the natural boundaries:

| Tool | Job | Gating | Mirrors |
|------|-----|--------|---------|
| `api-guide` | Introspect the guide store — `({})` → catalog (collapsed by `organization:`), `({domain})` → guide detail or disambiguation menu when multiple guides claim the domain, `({domain, guide})` → selected guide detail | `/api on` | `web-guide` |
| `api-fetch` | Execute a guided operation — `({domain, operation, params?, gatherAll?})` → result. `gatherAll` is read from the top level, with a fallback to `params.gatherAll` (stripped before it can leak onto a `passthrough` query string); on a non-paginated (`restGet`) op a truthy `gatherAll` emits a `gatherAll ignored — … is not paginated` notice rather than silently returning one page | `/api on` | `web-fetch` |
| `api-learn` | Submit/overwrite a guide recipe — `({domain, recipe})` → writes to disk | `/api learn` only | `web-learn` |
| `api-probe` | Discover the shape of a not-yet-guided API endpoint — `({apiHost, path, params?, tryPrefixes?})` → shape summary + draft YAML op block. Suggests only; never writes the guide | `/api learn` only | — |

The functions are **local read** (guide store), **network read** (execute
against target API), **local write** (submit recipe), and a second **network
read** gated to learn mode (shape discovery before a guide exists). Each tool
owns exactly one. A tool that mixes local-read and network-read (the old
arity-polymorphic `api-fetch` doing detail+execute) hides whether a call hits
the network behind an arity guess; a tool that mixes read and write hides
whether a call mutates state. Four tools eliminates both ambiguities. The
one benign polymorphism that remains — `api-guide({})` catalog vs
`api-guide({domain})` detail (vs `api-guide({domain, guide})` selecting one
of several guides claiming a domain) — is read/read, all local, the same "list mode
when called without a target" pattern `web-guide` already uses and LLMs
handle fine. The harmful read/write and local/network polymorphisms are gone.

This resolves the reviewer's N6 concern proactively rather than provisionally:
there is no arity-driven return-shape selection left to observe. The
one-tool escape route the original doc conceded as "live, not theoretical" is
applied upfront, extended with the authoring tool pulled out of `api-fetch`.

`api-fetch` resolves every guide claiming `domain` (a domain may claim
several — each in its own directory), finds the named `operation` across
them, and executes it against the matching guide, resolving that guide's
helper by its directory name (`dirName`), not the routing `domain`. It
injects auth (when the guide declares a keyed strategy — deferred past v1;
the `auth.kind` seam exists but only `none` is realized), runs the operation
through the declared helper on a configured undici `Agent`, and returns
parsed items (+ a continuation handle if paginated). The agent never sees a
URL, never sees a header, never sees the auth scheme.

The self-correcting execute-fail from the one-tool design is portable:
`api-fetch({domain})` with no guide for that domain fails *informingly* and
points at `api-guide({})` (to list guided domains) and `/api learn` (to
author one). Embedding the catalog in the failure body is an optional
one-fewer-round-trip convenience, not a load-bearing piece — `api-guide` is
the canonical introspection path.

Tool naming: the `api-*` family mirrors the `web-*` family by design. An
agent or dev who knows `web-guide` / `web-fetch` / `web-learn` can reason
about `api-guide` / `api-fetch` / `api-learn` by analogy. That is a
legibility win, not aesthetics.

- **Kinship with `web-fetch`.** `api-fetch` is a stateless, undici-backed
  sibling of `web-fetch` — the name signals that relationship.
- **"fetch" scopes to GET-read**, which is the actual v1 scope. `api-call`
  implies any method and invites "why no POST?" before a guide needs one.
- **No show knowledge required.** Tool names describe the action, not the
  origin package (`web-search` doesn't echo `pi-lean-search` either).

## undici as the transport

undici is a transitive dependency of pi agent (present under its `node_modules`),
but host lists `undici` as an explicit `dependency` in its own `package.json` —
transitive resolution is not guaranteed in a host-only npm install where the
resolution tree may differ from the monorepo's hoisted layout. Portal and search
both list their runtime deps explicitly; host follows the same discipline.
A per-domain undici `Agent` with interceptors handles the infra-class mistakes
*without per-call code*: retry-on-429 with backoff, redirect policy, sane
timeouts. That's infrastructure, configured once per domain in the tool; the
agent never sees it. This is the layer where retry/timeout/redirect live —
not in a helper, not in the guide.

**Caching is free leverage of the recipe layer.** A real win of
recipes-over-ad-hoc is that the tool can cache (ETag / `Cache-Control` / a
simple per-domain TTL) — the agent currently re-fetches the same BOE dispatch
across turns. Because the tool already owns a per-domain `Agent`, caching
belongs in that same transport layer, not in a helper or the guide. One
sentence here; the specifics (TTL policy, cache key) come later.

**SSRF guard (server-supplied URLs only).** Host guards only the one URL
path that earns it: `paginate`'s `nextLink` style, where `nextUrl` comes from
the **remote API's response body** — a URL the agent did not choose and the
user did not choose. That is the actual SSRF shape (untrusted input directing
where the fetcher goes next), and it is the one path where a guard is not
theater. `ssrfGuard()` (a minimal ~30-line `core/ssrf-guard.ts`, no deps, no
portal import — NOT a verbatim copy of portal's `url-safety.ts`) blocks
loopback, private RFC1918 ranges, and cloud metadata endpoints
(`169.254.169.254`, `metadata.google.internal`, `100.100.100.200`) on the
server-supplied `nextUrl` before it is followed.

Agent-supplied URLs are NOT guarded. `restGet` / `buildUrl` assemble a URL
from `apiHost` + `operation.path` + query params — all agent- or user-directed.
The agent runs on the user's own machine with the user's own privileges and
has `bash`, `read`, and `write` over the entire filesystem; blocking
`http://169.254.169.254/` on `restGet` while `curl` is one tool-call away is a
sieve with one hole patched. The classic SSRF framing (a privileged server
tricked by untrusted input into reaching an insider network) does not apply
when the "server" is the user's own agent process acting on the user's
instructions. So `apiHost: http://169.254.169.254/` and an off-host-escaping
`path` are allowed through `restGet` — the user asked for them.

Scheme-blocking and the secret-in-URL regex are dropped entirely. undici only
fetches `http:`/`https:`; the agent has bash for every other channel those
checks would protect. The secret-in-URL heuristic was noisy and protected a
channel the agent does not use for secret handling — when keyed auth arrives,
prefer header-based auth (the `auth.kind` seam) so tokens never enter the URL.

The nextLink guard's value is latent in v1 (`auth.kind: none` only, so no
credentials are attached to the fetch): a malicious API can still redirect
pagination to a metadata endpoint and land its response in the agent's
context, but the agent could fetch the same metadata via bash. The guard
becomes load-bearing the moment `checkAuth` stops throwing on `static-key` /
`oauth2` — at that point a server-supplied `nextUrl` to an internal host
would leak the attached `Authorization` header, which is textbook SSRF and
the one thing the agent's bash cannot do for the attacker. The guard is in
place now so that channel is closed before the credential-bearing path
ships.

## Secrets management

### v1 ships the seam, not the store

Not every API needs keys — **BOE, the v1 reference, is no-auth** (verified
against the live endpoint: a bare GET to
`/datosabiertos/api/legislacion-consolidada?limit=2` returns data, no key,
no header). v1 ships `auth.kind: none` only. No v1 recipe exercises
any auth path, so v1 ships **no secrets store at all** — not the OS-native
secret-store integration, not the file fallback, not the `requires`/
`scopes` resolution, not the secret-entry UX. None of that code is written
for v1.

What v1 *does* ship is the **seam**: the `auth.kind` field on the guide
schema and a dispatch in `restGet` that branches on it. The dispatch has one
realized case — `none` (and the implicit no-`auth`-block case, which is also
`none`) — and a default that errors on any unrecognized kind. This is the
placeholder for future auth work: the field and the dispatch point exist,
but nothing behind them does.

The seam is what makes the future refactor *additive* rather than a
retrofit. Auth is a **strategy selected by a guide field** —
`auth.kind: none | static-key | oauth2 | ...` — and adding `static-key`
(the next strategy, when a real keyed guide lands) and later `oauth2` (the
leading built-in candidate, reviewed security path) means **new strategies
behind an existing field**, not surgery on `restGet`'s call sites or the
guide format. If `restGet` baked "inject this header from the secret" in
unconditionally, the OAuth2 refactor would reach into `restGet` and the
guide schema simultaneously. If instead v1 had no seam at all — just "BOE
has no auth so I never think about auth" inline — the future refactor would
reach into `restGet` to *introduce* the dispatch. The seam is what keeps
both confined.

A consequence worth naming: the one built-in candidate flagged as
load-bearing (auth-token acquisition/refresh) is also the one *least*
validated by the v1 reference, because BOE never exercises the auth path.
That reinforces the "ship BOE-derived as a hypothesis, don't pre-build
OAuth2" call — and it means the `auth.kind` seam matters more, not less:
v1 ships only `none`, the auth-injection code path is literally untested
until a keyed guide arrives, and the seam is the only thing
keeping that future refactor additive.

### Why the store is deferred, not pre-built

The previous draft of this section shipped the store as v1 "forward
infrastructure" justified by a `scopes`-from-day-one argument. That argument
doesn't survive scrutiny: v1 has no keyed guide, so the store, `scopes`, and
`requires` resolution would all enter the world with **zero production
validation on the single most security-critical code path in the package** —
secret storage, retrieval, injection, and output-channel exfiltration
prevention. Building it before any guide exercises it is the same risk in a
different dress as "building OAuth2 because BOE needs it" — BOE needs no
auth. The lazy and honest move is to defer the store until a real keyed
guide lands, and ship only the `auth.kind` seam (field + dispatch) that the
future additive path depends on.

The `scopes`-from-day-one argument also weakens: `scopes` will be added to
the schema at the same time as `static-key`, not now. That is still a schema
grow, not a retrofit, because **no v1 guide has a `scopes` field to migrate**
— the grow is purely additive on a field that doesn't exist yet.

### The two threats (deferred, but named so the future build is not lazy)

The store is deferred past v1, but the threats it has to address are named
here so the future build lands properly on both fronts rather than being
lazy about the silent one:

1. **At-rest storage.** Where the key lives on disk. Plaintext JSON at `0600`
   is the lazy default and is explicitly **not** the choice when the store
   ships — the primary store is the OS-native secret store; a plaintext file
   is the fallback only when no secret-store daemon is available.
2. **The transcript / output channel.** The injection path has to be airtight
   across every helper and every error branch — a 401 response body echoed
   into a tool result leaks as surely as a `console.log` of the key. The
   existing codebase has no precedent for this surface (`storage-state.ts`
   handles filesystem races, not output-channel exfiltration). Every helper
   and every error path that returns content to the agent must be audited
   against this channel; it is the silent leak, more dangerous than the
   at-rest threat because it bypasses file perms entirely.

### Decisions deferred to when the first keyed guide lands

The following are **out of scope for v1** and are collected here as the
checklist for the first keyed-guide build, not as v1 work:

- **The at-rest store.** Linux-first: the **freedesktop Secret Service**
  (libsecret, backed by GNOME Keyring / KDE Wallet) over D-Bus as primary; a
~  plaintext JSON file at `0600` as fallback for headless servers, CI, and any
  environment where no Secret Service daemon is running (a common Linux
  case, not an edge case). macOS Keychain and Windows Credential Manager are
  supported **only if a single cross-platform Node.js library covers all
  three platforms at zero cost to the Linux path** — no Linux-only
  dependency, no Linux-only friction. If no such library exists or it adds
  any Linux inconvenience, macOS/Windows fall back to the plaintext-file
  store and the Linux-native Secret Service path stands alone. The
  dependency decision is gated on that constraint; it is not assumed solved.
  File-fallback location: `~/.pi/agent/pi-lean-host/secrets/<domain>.json`.
- **The `requires` / `scopes` schema.** A guide with a keyed `auth.kind`
  declares `requires: [apiKey]`, and each required secret carries a `scopes`
  field (`["read"]` by default, `["write"]` reserved for the future
  mutation gate). `api-fetch` injects the secret; the agent never reads the
  raw value. The mutation gate (when it arrives) is then "does this guide
  require a write-scoped key?" — not a re-invention of the secrets schema.
- **Secret entry UX.** A `/api secrets [domain]` subcommand is the leading
  candidate (mirrors `/web cookies` / `/web profile` as a visibility +
  management command owned by `pi-lean-host`). Whether entry is a CLI
  subcommand, a tool call, or a hand-edited file is TBD — but it is a UX
  choice on top of the storage decision above, not a substitute for it.

None of the above is built for v1. The `auth.kind` field + dispatch is the
entirety of v1's auth surface.

## Guide discovery

One link regime in v1:

- **Declared links — always safe, ship day one.** The guide's frontmatter
  asserts the mapping: `domains: [boe.es, www.boe.es]` + `apiHost:
  https://api.boe.es/v2` (or wherever the API actually lives). This is a human
  assertion (user via `/api learn`, or a user copying a bundled recipe), reusing the
  existing `domains` discovery mechanism verbatim. No inference, no false
  links — exactly as safe as web guides already are.

  The two fields are asymmetric on purpose. `domains` is the **discovery key**
  — plural bare aliases (`boe.es`, `www.boe.es`) that feed `buildDomainMap()`
  for the domain→guides lookup (a domain may map to several guides, each in
  its own directory); `restGet` never touches them. `apiHost` is the
  **execution root** — one full base URL (scheme + host + base path) that
  `restGet` joins each operation's relative `path` against to build the
  request URL. Carrying the base path in `apiHost` once keeps operation paths
  short (`/series/{id}`) and bakes the version prefix (`/v2/`, `/api/rest/`)
  into a single field so a version bump is one edit, not every operation. The
  agent never sees or constructs the full URL — `restGet` does.

The bright line: an API↔site link is only ever *applied* when a human asserted
it.

**Inferred-link discovery is deferred to v2.** It requires portal's HTML
source, an honest-signal scanner (`<link rel="api">`, OpenAPI/Swagger,
`robots.txt`), a candidate-suggestion UX, and a confirm-first flow — all for a
marginal win over declared links, which already cover the safe path. Worse,
it drags portal coupling into a package whose whole point is independence.
Declared links + user-authored guides + `api-guide` progressive disclosure is a
complete v1; inference is v2 scope creep. Revisit only after v1 has real
usage data showing declared links are insufficient.

## Guide-loader ownership: vendor the minimal copy

`pi-lean-portal/core/guides.ts` is ~100 lines coupled to `PORTAL_DATA_DIR`
(frontmatter parse, `domains` map, file load, the `Guide` type). Host needs
these primitives to work without portal installed. Three options were on the
table; the decision is made:

**Vendor a minimal copy of the loader in `pi-lean-host`.** For two consumers
and a stable ~100-line loader, a shared package is over-engineering and
portal-as-peer creates install-graph weirdness. Duplication is cheaper than
the dependency here. The copy stays minimal (frontmatter + `domains` map +
`Guide` type) and drifts rarely; if it ever grows meaningfully, revisit
extraction then. This is the one structural prerequisite for host-only
installs, and it is now closed, not open.

## Guide file format: one file, two consumers

An API guide is a single markdown file with YAML frontmatter — the same
physical format as a web guide. The frontmatter carries the structured
recipe (`apiHost`, `operations`, `pagination`, `auth`, `verified`,
`gatherAllMax`); the prose body carries orientation for the agent. One file,
two consumers, but the consumers read **different slices**:

- **Host** (`api-fetch`) reads the recipe slice — `apiHost`, `operations`,
  `pagination`, `auth.kind` — and executes against it. `api-guide` reads
  the detail slice (operations, auth notes, pagination style, the `verified`
  date) for introspection. Host owns the richer internal type (`ApiGuide extends
  Guide`) that carries these fields. Portal never imports this type.
- **Portal** (the navigate footer, `web-guide`, `formatGuideList`) reads only
  the **discovery + presentation slice** — `domains`, `icon`, `shortName`,
  `category`, `updated`, `kind`, and the prose `content`. This slice is
  exactly the existing `Guide` shape. Portal never needs `apiHost` or any
  recipe field.

This is a **projection boundary, not a type merge.** The guide-source
registry (see *Reactive surfacing*) hands portal a `Record<string, Guide>`
where each entry is a projection of the full `ApiGuide` — recipe fields
stripped, presentation fields kept. The registry contract stays
`() => Record<string, Guide>`; no signature change, no recipe-structured
data crossing into portal. The structured-vs-prose tension that originally
made the registry look unbuildable dissolves: host keeps its rich type
internally, portal sees only the `Guide`-shaped projection.

### Prose refers to tools and helpers by name

The prose body follows the same pattern web guides already use: the
`bot-detection` guide prose says *"use `browser-inspect role=\"dialog\"`"* —
it refers to a tool by name; the guide does not invoke it. An API guide's
prose says *"use `api-fetch` with operation `searchDiary`"* and *"the
`boe-datefmt` helper formats the date param"* — same pattern at a different
layer.

The split of authority is deliberate: **the prose is advisory, the
frontmatter is authoritative.** The prose orients the agent (what operations
exist, when to use each, quirks to know); the `operations[]` block defines
the executable contract (`api-fetch` reads it, not the prose). Both are
valuable — the prose is what makes the guide self-documenting when read via
`web-guide` in browse mode; the frontmatter is what makes it executable via
`api-fetch`. The footer never shows `content`; it shows `icon + shortName +
reason`, so an API guide surfaces in the footer identically to a web guide.
The prose body is served on demand — through `web-guide` (browse mode) or
through `api-guide({domain})` (api-only mode).

### Parser split: host parses recipes, portal never parses API files

Portal's `parseGuideContent()` is a naive flat `key: value` line splitter —
it cannot handle the nested `operations:` / `auth:` / `pagination:` blocks an
API guide needs. This is correct and stays as-is: **portal never parses
API-guide files.** API guides live only in the user's directory
(`~/.pi/agent/pi-lean-host/api-guides/`); portal only ever
receives the projection object via the registry. Host's vendored loader
parses the full frontmatter (nested blocks included) with a real YAML parser
(or structured-block parser); portal's parser stays dumb and handles only
flat web-guide frontmatter. No shared parser, no format collision — the two
loaders share a *file format* (markdown + frontmatter) but not a *parser*.

### Helper references stay host-internal

`operation.helper` is a recipe field (a boolean: `true` = use this domain's
helper), stripped in the projection to portal — portal has no concept of
helpers. The trust boundary is placement, not a load-time helper-name
check: only files under `~/.pi/agent/pi-lean-host/` load and execute, so a
helper resolves only against the `helper.ts` in the user's own
`api-guides/<domain>/` folder. Bundled recipes may carry `helper: true` as
a worked example, but it is inert until the domain folder is copied. This
keeps the trust boundary entirely in host and entirely at the user's opt-in.

## Guide recipe schema

The concrete shape of the frontmatter recipe block — the load-bearing piece
deferred to "specifics" in the opening note. It resolves the one blocker the
design-gate review named: without it, the `restGet`/`api-fetch`/`api-learn`
execution and authoring paths can't be scoped into sprint tasks.

### Design decisions, named so they aren't re-litigated at sprint time

Five choices, each with the rejected alternatives named so a planner doesn't
reopen them:

1. **Executor is `via`, not `kind` or a split array.** Each operation names
   its executor explicitly: `via: restGet | paginate`. Rejected: a separate
   top-level `lists:` array (splits one concept for one discriminator) and
   `kind: read|list` with an inferred executor (a second vocabulary for the
   same thing). `via` is one field, one validation.
2. **Path params are inferred from `{token}` in `path`; query params are
   declared under `params:`.** The path *is* the path-param declaration —
   declaring them again is redundant. Query params get `required`/`default`
   validation because hand-passing wrong/missing query params is a
   repeat-mistake class the tool exists to kill. Rejected: declaring all
   params with `in: path|query` (redundant for path) and pass-through with no
   declaration (drops validation).
3. **`pagination` and `responseShape` are top-level defaults; operations
   override.** Most APIs share one pagination style and one response shape
   across endpoints; the odd endpoint overrides. Rejected: per-op-only
   (repeats the same block on every op) and infer-from-`Accept`-only (loses
   charset fixing, a named top repeat-mistake).
4. **`via` = executor; `helper` = one coarse local user-transform that
   receives the param map and returns the final map.** This resolves the
   doc's overloaded "helper" (executor *and* "the `boe-datefmt` helper
   formats the date param"). `via` is the executor; `helper` (a boolean on
   each op: `true` = run this domain's helper) reserves the word for the
   user-owned transform concept the prose already uses. One helper per
   domain (not per-op, not per-param) is enough for one reference API;
   granular per-param binding is YAGNI until a second API forces it.
   Rejected: `helper` = executor with local transforms called
   `transform:`/`pre:` (swims against the doc's own wording), a named-helper
   string reference (couples guides across domains — dropped in the
   per-domain layout; a guide uses its own domain's helper or none), and
   granular `params.X.helper: name` (over-spec'd for v1).

   **Helper contract:** `(params: Record<string, unknown>, ctx: { operation: string; domain: string }) => Record<string, unknown> | Promise<Record<string, unknown>>` — a pre-call transform: it receives the resolved param map (path + query merged, defaults filled) and returns the final map the executor templates and sends. It may be sync or async (awaited either way). It runs only on the user's own machine as a local user-helper (only user-placed guides load; see *Three tiers of code*). A gated post-response `transform` named export was later added to the same `helper.ts` — a separate valve that shapes the parsed response after `restGet`/`paginate` (graceful: a throw returns the raw body and never disables the op). It is documented as a built-in contract row in [`api-helper-escape-valve.md`](./api-helper-escape-valve.md) §12; the pre-call-only contract above is unchanged.
5. **`parseResponse` config *is* `responseShape`/`parse`.** No separate
   binding — `parseResponse` is the transform that consumes this config.
   Top-level `responseShape:` default, per-op `parse:` override (mirrors
   decision 3).

### Schema (YAML frontmatter)

```yaml
---
# ── projection slice (portal reads these; recipe fields stripped) ──
kind: api                          # "web" | "api" — host-first ordering hint; defaults "web"
domains: [boe.es, www.boe.es]      # discovery keys → buildDomainMap()
icon: ⚖️                            # badge + footer bullet
shortName: BOE                     # badge label
updated: 2026-07-17                # ISO date; portal presentation
# ── recipe slice (host-only; ApiGuide extends Guide) ──
organization: boe.es                # OPTIONAL org identity across guides (registrable domain; catalog grouping + disambiguation)
description: BOE open-data API.     # OPTIONAL one-line summary (≤200 chars, no newlines; primary disambiguation signal for multi-guide domains)
apiHost: https://apidatos.boe.es/v1   # execution root; scheme+host+base path
verified: 2026-07-17               # defaulted to creation date, NOT enforced
gatherAllMax: 500                  # per-guide gatherAll ceiling; global fallback if absent

auth:                              # v1 ships ONLY kind: none; seam for static-key|oauth2
  kind: none

# ── top-level defaults; operations inherit and may override ──
pagination:
  style: offset-limit              # offset-limit | nextLink | cursor | page | resumptionToken | tokenBag
  pageParam: page                  # offset-limit / page: the page-number param
  pageSizeParam: limit             # offset-limit / page: the page-size param
  pageSize: 50                     # offset-limit / page: requested page size
  itemsPath: data                  # where the items array lives in the body
  # `page` shares these exact fields with `offset-limit`; the only difference
  # is semantic — `offset-limit` sends an absolute offset, `page` sends a
  # 1-based page number — so they use the same param names and parser.
  # nextLink style:
  #   nextLinkPath: pagination.next   # JSON path to the next-page URL
  # cursor style:
  #   cursorParam: cursor             # the cursor query param
  #   cursorPath: pagination.nextCursor  # JSON path to the next cursor
  # resumptionToken style (OAI-PMH opaque single-token cursor):
  #   tokenParam: resumptionToken     # query param to echo the opaque token into
  #   tokenPath: OAI-PMH.ListRecords.resumptionToken.#text  # JSON path to the next token
  # tokenBag style (Wikimedia `continue` dict — multi-key continuation):
  #   continuationParams: [continue, rccontinue]  # response keys merged into the next request's params
  # totalCountPath (OPTIONAL, any style): JSON path to the server's reported
  #   total count, surfaced as `serverTotal` in the paginate result and as
  #   `server total: N` / `remaining: …` in the api-fetch footer. Declared
  #   per-pagination-block (top-level or op-level). APIs that expose no total
  #   simply omit it; `serverTotal` stays undefined. (Supersedes the
  #   pre-release `completeListSizePath` field, which was removed, not aliased.)

responseShape:
  format: json                     # json | xml → drives parseResponse
  charset: utf-8                   # utf-8 | auto (auto = sniff from headers)

operations:
  - name: searchDiary              # the `operation` arg passed to api-fetch
    via: restGet                   # executor: restGet | paginate
    path: /diario/{date}           # {token} = path param, inferred — no decl
    accept: json                   # json | xml — request-side Accept header
                                   # (distinct from responseShape.format, the
                                   # response-side parser; they usually match
                                   # but an API may return XML regardless of
                                   # Accept, so they're declared independently)
    params:                        # query params only; path params from tokens
      limit:
        default: 50
        # required: true           # default false
      date:                        # OPTIONAL docs-only channel for a {date} path token:
        description: Diary date, yyyy-mm-dd form.   # {date} is filled from the path,
                                    # never a query param; rendered via api-guide
    # dateParams:                  # OPTIONAL: param → target date format; ISO dates
    #   from: yyyymmdd             # auto-converted in buildQueryParams before serialization.
    #                              # Formats: iso8601 | yyyymmdd | yyyy-mm-dd. Query params only;
    #                              # path-param dates stay in helper.ts (BOE `fecha`).
    helper: true                   # OPTIONAL: run this domain's local helper (coarse transform)
    # parse:                       # op-level responseShape override
    #   format: xml
    #   charset: iso-8859-1

  - name: listConsolidada
    via: paginate
    path: /legislacion-consolidada
    accept: json
    pagination:                    # overrides top-level default
      style: cursor
      cursorParam: cursor
      cursorPath: pagination.nextCursor
      itemsPath: results
    gatherAllMax: 1000             # op-level ceiling override
---
# prose body: orientation for the agent (advisory; frontmatter is authoritative)
```

### Field reference (defaults marked)

| Field | Level | Default | Purpose |
|---|---|---|---|
| `kind` | guide | `"web"` | host-first ordering hint on the projection |
| `domains` | guide | — | discovery keys (plural bare aliases) |
| `icon` / `shortName` / `updated` | guide | `📖` / filename / today | portal presentation slice |
| `apiHost` | guide | — | execution root: scheme + host + base path; version prefix lives here |
| `organization` | guide | — | OPTIONAL org identity across guides (use the org's registrable domain); catalog grouping + multi-guide disambiguation. Recipe-slice only, never projected to portal |
| `description` | guide | — | OPTIONAL one-line API summary (≤200 chars, no newlines; enforced on the `api-learn` write path, lenient on read). Primary disambiguation signal when a domain has multiple guides. Recipe-slice only |
| `verified` | guide | creation date | drift signal; **defaulted not enforced** |
| `gatherAllMax` | guide / op | global fallback | per-guide `gatherAll` ceiling; op can override |
| `auth.kind` | guide | `none` (or no `auth` block) | strategy seam; v1 realizes only `none` |
| `pagination.style` | guide / op | — (required when `via: paginate`) | `offset-limit` \| `nextLink` \| `cursor` \| `page` \| `resumptionToken` \| `tokenBag` |
| `pagination.itemsPath` | guide / op | — | JSON path to the items array in the body |
| `pagination.totalCountPath` | guide / op | — | OPTIONAL, any style: JSON path to the server's reported total count, surfaced as `serverTotal` in the `paginate` result and as `server total: N` / `remaining: …` in the `api-fetch` footer. Omitted → `serverTotal` stays `undefined`. Supersedes the pre-release `completeListSizePath` (removed, not aliased) |
| `responseShape.format` | guide / op | `json` | `json` \| `xml` → drives `parseResponse` |
| `responseShape.charset` | guide / op | `utf-8` | `utf-8` \| `auto` (sniff from headers) |
| `operations[].name` | op | — | the `operation` arg `api-fetch` takes |
| `operations[].via` | op | — | executor: `restGet` \| `paginate` |
| `operations[].path` | op | — | relative path; `{token}` = inferred path param |
| `operations[].accept` | op | `json` | `json` \| `xml` — request-side `Accept` header (distinct from `responseShape.format`, the response-side parser selection; they usually match but need not) |
| `operations[].params` | op | `{}` | query params; `{ required?: bool, default?: value, description?: string }` per key. Path tokens may carry ONLY a docs-only `description` (`params.<token>.description`), routed to `Operation.pathParamDocs` (surfaced via api-guide, never sent as a query param) |
| `operations[].dateParams` | op | — | OPTIONAL `{param: format}` mapping; normalizes ISO dates to `iso8601` \| `yyyymmdd` \| `yyyy-mm-dd` in `buildQueryParams` (query params only; path-param dates stay in `helper.ts`) |
| `operations[].helper` | op | `false` | OPTIONAL boolean — `true` runs this domain's local user-helper (the `helper.ts` in the guide's `api-guides/<domain>/` folder; bundled recipes may carry `true` as a worked example, inert until the domain folder is copied) |
| `operations[].passthrough` | op | `false` | OPTIONAL boolean — `true` forwards caller-supplied params not declared in `params` onto the query string as-is. For APIs with an open param surface (Infogami `/query.json`, CKAN, OAI-PMH) where the caller supplies type-specific keys at query time. Default `false`: closed contract — extras dropped so the agent gets a predictable request, not a silent miss on an undeclared key |
| `operations[].parse` | op | inherits `responseShape` | op-level override of format/charset |
| `operations[].pagination` | op | inherits top-level | op-level override of pagination style |

### Authoring & validation behavior

**`api-learn` takes `recipe` as a string, not a nested object** — mirroring
`web-learn`'s `content: string`. The tool's param schema stays shallow
(`{domain: Type.Optional(string), recipe: string}`), so the rich recipe
shape never sits in the system prompt on every turn. `domain` is optional:
required for the write path, absent for the worked-example path (a no-arg
call returns the example below). A nested `recipe` object schema would
re-introduce the per-turn context cost moving the example out of the
description was meant to eliminate; a string param dodges it.

**The worked example is delivered on demand, not in the description.**
Calling `api-learn` without a `domain` returns a worked example recipe that
exercises *every supported field* (see below) plus the field reference —
read once at authoring time, never carried on executing turns. Agents
generalize from a concrete instance better than from a skeleton, so the
example is a real small recipe (the BOE shape), not a `___`-placeholder
template. The skeleton is implicit in it. This is the one affordance for
the schema; there is no `/api init` scaffolding command and no template
write step — `api-learn` *is* the write path, so "call it to get a template
then edit" collapses to "call it with the full recipe."

**Defaults are filled by the validator, not by a template write.** The
agent authors the interesting parts (`apiHost`, `operations`) and omits the
boring ones; the tool fills defaults on validate-and-write: `auth` omitted →
`none`; `verified` omitted → today; `gatherAllMax` omitted → global fallback;
`responseShape.format` omitted → `json`; `pagination` omitted → only
required when an op is `via: paginate`. No first-invocation round-trip.

**One parser, two call sites.** A single `parseApiGuide()` returns
`| { ok: true; guide: ApiGuide } | { ok: false; error: ParseError }`, used
by both `api-learn` (validate-before-write) and the loader (read-from-disk).
No second validator to drift out of sync. The `ParseError` shape is fixed
so both call sites render identically:

```ts
type ParseError = {
  file?: string;        // on-disk path (load-time) or omitted (write-time)
  field: string;        // dotted path to the failing field, e.g. "operations[1].path"
  expected: string;     // one-line shape description, e.g. "a string beginning with /"
  found: string;        // what was actually there, e.g. "diario/{date} (missing leading /)"
  snippet?: string;     // the failing block verbatim, for context
  fix?: string;         // the minimal correction, when the validator can suggest one
};
```

**Write-time rejection (agent is present).** `api-learn` validates the
`recipe` string before touching disk: on a structural error, name the field,
the expected shape, and what was found; leave the file on disk untouched
(no half-written guide). The agent is right there with the params — this is
the cheap catch.

**Load-time error (file already on disk).** `api-fetch` / `api-guide`
reading a malformed on-disk guide return a structured error, not a crash:
which file, which block/field, expected vs found, the minimal fix, the file
path for manual edit, and the expected schema snippet for the failing
block (so the agent doesn't re-derive the whole recipe from docs). Repair
path named: `api-learn({domain, recipe: <corrected>})` to overwrite.

**One malformed guide doesn't block the store.** Portal's `loadUserGuides()`
already skips files that fail `parseGuideFile` (returns `null`, doesn't
crash the map). Host does the same, but *visible*: `api-guide({})` catalog
still lists healthy guides; the broken one shows with a `⚠ malformed` badge
and the error inline rather than silently disappearing. Silent
disappearance strands the agent — it thinks no guide exists and re-authors
from scratch instead of fixing the one broken field.

### Worked example (returned by `api-learn` with no `domain`)

A complete recipe exercising every supported field, so the agent can see
what it can add beyond the defaults. This is the BOE shape, small and real:

```yaml
---
kind: api
domains: [boe.es, www.boe.es]
icon: ⚖️
shortName: BOE
updated: 2026-07-17
# organization: boe.es        # OPTIONAL: org identity across guides (catalog grouping + multi-guide disambiguation)
# description: BOE open-data API.  # OPTIONAL: one-line summary (≤200 chars, no newlines)
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
  # nextLink alternative:
  #   nextLinkPath: pagination.next
  # cursor alternative:
  #   cursorParam: cursor
  #   cursorPath: pagination.nextCursor
  # resumptionToken alternative (OAI-PMH):
  #   tokenParam: resumptionToken
  #   tokenPath: OAI-PMH.ListRecords.resumptionToken.#text
  # tokenBag alternative (Wikimedia continue dict):
  #   continuationParams: [continue, rccontinue]
  # totalCountPath (OPTIONAL, any style): JSON path to the server's reported
  #   total count → surfaced as `serverTotal` / `server total: N` in the
  #   api-fetch footer. Omit when the API exposes no total.

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
    # dateParams:                  # OPTIONAL: param → target date format
    #   from: yyyymmdd             # ISO dates auto-converted; formats: iso8601 | yyyymmdd | yyyy-mm-dd
    helper: true
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
    gatherAllMax: 1000
---
# BOE Legislación Consolidada — structured API access

Use `api-fetch` with `operation` `searchDiary` to pull a day's dispatch
(pass `date` as `YYYYMMDD`). Use `listConsolidada` to walk consolidated
laws with `gatherAll: true` (capped at 1000 by the op override).

The `boe-datefmt` helper formats the `date` param; it lives at
`~/.pi/agent/pi-lean-host/api-guides/boe.es/helper.ts` and runs only in
`/api learn` authored form on this user's machine.
```

When `api-learn` returns this, it prepends one line: *"Example recipe —
copy, edit, and call `api-learn({domain, recipe: <your edited string>})`
to save. Fields marked optional or commented show the defaults you can
omit."*

## Discovery & authoring

Guide *application*, *discovery*, and *authoring* are three problems, and
the decoupled toggle changes how each works.

**Application** is uniform across modes: `api-fetch` takes `domain` as a
parameter, so guide resolution is a domain→guides lookup via `buildDomainMap()`
(a domain may claim several guides; `api-fetch` resolves the operation by
name across them) — no navigation event required. The tool resolves the
guide(s) from the supplied domain regardless of whether any web tool is
active.

### Discovery: two models keyed to the trigger

Portal's guide discovery is elegant because it piggybacks on a rich,
frequent, domain-bearing event (navigation) that the agent performs for its
own reasons — the guide finds the agent. Host-only mode has no equivalent
event: the agent doesn't "navigate" to an API, and it reaches for a tool
(`api-guide` or `api-fetch`) only when it already has a domain in mind, so
reactive surfacing *before* a call is circular. The two modes therefore
have different discovery *models* because they have different *triggers* —
this is the design, not a gap.

**On-demand-by-domain (host-only, primary).** The API workflow is
domain-first, not browse-and-stumble: the user's request names the domain
("pull yesterday's BOE dispatch" → `boe.es`) before the agent touches any
tool. Discovery collapses to *is there a guide for the domain I already
have?* — `api-guide({ domain: "boe.es" })` returns the guide detail in one
call. The agent doesn't need to know guides exist; it calls the tool with
the domain it already has, and the guide (or its absence) is in the
response. No catalog sits in context permanently; the guide comes back
through the introspection tool, and the agent then calls `api-fetch` to
execute. `api-guide({})` returning the full catalog is the rarer fallback
for when the user doesn't name a domain ("what APIs do I know about?").

**Self-correcting execute-fail.** When `api-fetch` is called with a `domain`
that has no guide, the execute call fails *informingly* and points the agent
at `api-guide({})` (to list guided domains) and `/api learn` (to author
one). This turns a failed execute attempt into a discovery moment in one
round-trip, without growing `api-fetch` a bare-fetch mode (the call still
fails to execute — it just fails informatively). It is the closest
host-only can get to "the guide finds the agent": the agent reaches for a
domain, and the tool redirects it to where guides *are*.

**Reactive surfacing (browse mode, portal-unlocked).** When portal is
co-installed and `/web` is on, host guides can surface in portal's navigate
footer by domain match (gated by `/api on`) — the same reactive mechanism
web guides use. This requires a **guide-source registry** in portal's
`guides.ts`: an array of `() => Record<string, Guide>` providers that peer
packages register at load time, merged into `getGuideContent()` alongside
portal's builtin + user guides. Host registers a **projection** of its
user-authored `ApiGuide`s — the only kind that load (bundled recipes are
inert, so they have nothing to project) — recipe fields stripped,
presentation fields kept (see *Guide
file format: one file, two consumers*) — so the registry contract stays
`() => Record<string, Guide>` with no signature change and no recipe data
crossing the boundary. The dependency direction is host→portal (host opts in
via `registerGuideProvider` at its entrypoint); portal never imports host.
Host-only installs don't register and lose nothing — reactive surfacing is
an enhancement for co-installs, not a host-only requirement. The on-demand
path above is fully functional without it. On name collision, user-authored
guides still win over peer-package guides, preserving the existing "user
overrides builtin" precedence.

**Known limitation — api-only is a known-domains mode.** If the user's
request does not name a domain and no guide in the catalog matches, the
agent cannot discover a brand-new API from scratch in api-only mode. That
requires either web tools (to search/browse and find the API) or the user
to supply the domain. This is an inherent trade-off of a clean api-only
context, not a design flaw — and a richer discovery mechanism wouldn't help,
because without browse/search tools the agent can't act on an unknown API
regardless.

### Authoring: spec-first, probe-second

Browser guide authoring works by *interacting with the thing and watching it
respond* — probe-first. API authoring should work by *reading the contract
and encoding it, then verifying the encoding* — spec-first, probe-second.
The trial-and-error the browser has isn't absent from the API path; it lives
at the *verification* step, not the *discovery* step. Trying to make API
authoring probe-first is the wrong model: it forces the agent to rediscover
what the documentation already states, and documentation is the one thing
good APIs have that bad DOMs don't.

**The core mechanism: write → verify → fix.** `/api learn` is the *mode*
that enables the `api-learn` tool. `api-learn({domain, recipe})` writes
the guide directly to disk — `~/.pi/agent/pi-lean-host/api-guides/<domain>/guide.md`,
overwriting any existing guide for that domain — exactly as `web-learn`
writes prose guides today. There is no draft store, no `/api save`, no
session-held state: the file on disk *is* the working state. The verify
loop is `api-learn` (write the candidate recipe) → `api-fetch` (run it,
see the 404 or the wrong-shaped JSON) → `api-learn` (fix the frontmatter,
overwrite) → `api-fetch` (run again) — exactly like the browser's
`web-learn` → `browser-navigate` → `web-learn` loop, just at the recipe
layer instead of the DOM. The error signal is richer than the browser's
(HTTP status + structured error body vs. "the page looks the same").
Verification is implicit, not gated: a guide on disk that has been
successfully executed against *is* verified, and the agent does this
naturally by calling `api-fetch` after `api-learn`. `api-learn`'s return
message nudges this ("guide saved; call `api-fetch({domain, operation})`
to verify"). This is the whole authoring mechanism — symmetric with the
web family, no extra command, no session machinery.

**Authoring paths, prioritized:**

1. **Documentation-driven (primary, works host-only).** The agent reads the
   API's documentation — via `web-fetch` (portal) or pasted/filepath by the
   user (host-only) — encodes it as a recipe via `api-learn`, and verifies
   with `api-fetch`. The docs *are* the affordance: they state endpoints,
   params, auth, pagination. This is the natural default, not a fallback.
2. **Example-generalization (works host-only).** The user pastes a working
   curl command or code sample; the agent generalizes from the one example
   to a recipe, writes it via `api-learn`, verifies with `api-fetch`. A
   single working call teaches the base URL, the Accept header that works,
   the response shape — most of a recipe from one data point.
3. **Probe-and-verify (host-native via `api-probe`, last resort).** The
   `api-probe` tool (gated to `/api learn`) fetches a not-yet-guided endpoint
   over the same `transport.ts` pipeline as `api-fetch` — UA, charset,
   429-retry, ETag, and WAF handling for free, no portal needed — and returns
   a shape summary plus a copy-paste-ready draft YAML op block. It **suggests;
   it never writes the guide**: the "cite the source" gate stays human. The
   authoring family is `api-probe` (discover shape → draft) → `api-learn`
   (validate schema + save) → `api-fetch` (execute the saved op). `api-probe`
   takes a templated `path` + `params` dict (not a literal URL) so the draft is
   true copy-paste, mirroring the parser's rule that path params are inferred
   from `{token}` in `path` and not re-declared. This is the last resort, not
   the default, because reading the docs is cheaper than probing the API, and
   good APIs almost always have docs. A portal-dependent variant — `web-fetch`
   to hit endpoints blindly — remains available when portal is co-installed.
4. **OpenAPI/Swagger import (deferred to v1.1).** When a machine-readable
   spec exists, a spec→recipe transformer is mechanical — the case where
   APIs are *less* rigid than browsers, since the contract is structured
   input. Build it when a second guide with a spec arrives; YAGNI for v1
   (one reference API, boe.es, has none).

**No ad-hoc bare-fetch mode on `api-fetch`.** `api-fetch` is the guided path;
the guide is the product. Growing it a bare-fetch mode for unguided calls is
the thin end of the wedge — it muddies the discipline and recreates the exact
mistakes (hand-rolled auth, no pagination) the tool exists to prevent. The
correct escape hatches are `api-learn` (write a guide, then execute through
it — the first verified call is a guided call), `web-fetch` (portal) for a
one-off unguided fetch. The narrow gap — host-only install, ad-hoc unknown
API with no docs and no example, no guide, no portal — has no HTTP tool at
all; state this as a known limitation rather than growing `api-fetch` an
ad-hoc mode to cover it.

**No draft store — direct write, like `web-learn`.** The earlier draft of
this design held drafts in the session journal (`pi.appendEntry("api-draft-guides", ...)`)
and promoted them with a `/api save` command. That was a solution to a
problem the web family already solves more simply: `web-learn` writes
directly to disk, no draft, no `/web save`, no session state. The guide is
live the moment the tool returns; if it's wrong, the agent calls `web-learn`
again to overwrite. `api-learn` does the same. The draft/journal/`/api save`
machinery — the `api-draft-guides` entries, the branch walker, the tombstone
on save — is gone entirely, and with it the reviewer's N2 "stateless
contradiction": `api-fetch` is genuinely stateless now (every call reads the
persisted guide from disk, executes, returns), with no session-held draft
state to reconcile. Last-write-wins on the guide file is the same semantics
`web-learn` already accepts; parallel authoring of the *same* API guide in
forked sessions is an exotic scenario, not a v1 requirement.

**Host-only authoring boundary.** Host-only authoring is docs-driven and
example-driven (paths 1–2); it works end-to-end with no portal dependency
because the write→verify loop is itself a guided call against the on-disk
recipe — `api-learn` writes, `api-fetch` verifies, neither needs an
unguided HTTP tool. Probing a genuinely undocumented API with no example
(path 3) requires portal's `web-fetch`. This does not block host-only *use*
(declared links + user-authored guides + `api-guide` + `api-fetch` work fine) — it narrows
the authoring limitation to the undocumented-API case only.

## Toggle & status integration: a peer, not a child

Host owns an **independent** `/api` toggle, separate from `/web`. They are
peers, not parent/child. The concrete win that justifies the machinery is
**api-only mode**: `/api on` + `/web off` turns off every `browser-*` tool
while keeping structured API access live. The sibling-union model used for
search cannot give you that — `/web off` would kill both browsing and API
access together.

**The use case that pays for the peer toggle:** batch structured-data work
against a known API — pulling many BOE dispatches across dates, walking a
paginated JSON endpoint to exhaustion, repeatedly querying a documented
read API — where the `browser-*` tools are pure context noise the user wants
gone, but API access must stay on. That workflow is the reason for the
independent toggle, not the "APIs talk to machines, browsing is human-facing"
metaphor. If api-only mode turns out to be a workflow nobody runs, the peer
machinery is not worth it and host should fold under `/web`; v1 bets that it
is a real workflow and ships the peer toggle on that bet.

Mechanics, mirroring `/web`:

- `/api on|off|learn` mirrors `/web on|off|learn`. Toggle state persists via
  the `pi-tool-masking` library (`persistKey: "toolset-state:pi-lean-dimension.api"`),
  surviving `/reload`/`/resume`/`/fork`, the same mechanism as portal's web
  toggle. Session defaults are overridable via the `toolsetDefaults` block in
  merged Pi settings.
- `/api on` exposes `api-guide` + `api-fetch`; `/api off` removes both.
  `/api learn` adds `api-learn` (authoring) on top of `on`, mirroring `/web
  learn` adding `web-learn`.
- **`setActiveTools` contract — additive on, filter off.** Because `/api` and
  `/web` are peers over the same tool set, host must follow portal's
  `applyBrowserState` pattern exactly: `on` is **additive** (merges the
  `api-*` tools into `getActiveTools()`, never replaces the set); `off` is a
  **filter** (removes only its own tool names from `getAllTools()`, never
  touches another toggle's tools). A naive
  `setActiveTools(["api-guide", "api-fetch"])` on `/api on` would wipe every
  `browser-*` tool; a naive `/api off` could remove tools it doesn't own. This contract is what makes "both toggles
  compose freely" actually true rather than just claimed — it is a
  requirement on the implementation, not an emergent property.
- Both toggles compose freely: `/api on` + `/web off` = API-only context (no
  `browser-*` tools); `/web on` + `/api off` = browse-only; both on = both
  available. The user controls what is in context per install and per
  session — this is the core utility of decoupling.
- An `api` status-bar glyph slot, independent of the `browser`/`search`
  slots. Shown only when `/api` is on and a host guide is active for the
  current domain, so it is not always-on noise. Off-state: `○ api`.
- Search stays under `/web` (it is part of the browsing family; decoupling
  it would be churn without a use case).

## Surfacing: host-first, with a stated reason

A host guide does **not** suppress the web guide for its domain. Both surface
by domain match; the user decides which to act on. Reasons suppression stays
off:

- APIs frequently have **partial coverage** — the web guide fills the gaps
  the API doesn't cover.
- Suppression requires "is this a data-retrieval task?" guessing, which is
  fragile and out of scope.

When both a host guide and a web guide match a domain, **the host guide
surfaces first.** This is a one-step preference, not a ranking engine and not
suppression: API access is cheaper (no browser session), more reliable
(declared recipe vs. scraped DOM), and lower-context (parsed items vs.
accessibility tree) than browsing, so when both are available the cheaper
path is presented first. Both still surface; the user/agent is free to take
the web guide instead. There is no "zero ranking" claim — there is a
deliberate one-step preference with a stated reason, and nothing below it.

**Mechanism: a `kind` field on the projection.** Host-first ordering requires
portal's `resolveApplicableGuides()` to distinguish API guides from web
guides within the merged map — it currently sorts `patterns → sites,
alphabetical within`, with no way to put host guides before web guides.
The fix is one optional field on `Guide`: `kind?: "web" | "api"`, defaulting
to `"web"`. This is not recipe-structured data leaking into portal (the
`apiHost`/`operations`/`pagination`/`auth` fields all stay in host's
`ApiGuide`); `kind` is a **presentation-ordering hint** that portal
legitimately consumes for three things: (1) host-first ordering within the
same category in `resolveApplicableGuides()`; (2) a clearer `reason` string
(`"API guide for boe.es"` vs the generic `"site guide for boe.es"`); (3)
grouping under its own header in `formatGuideList()`. One field, three
portal-side uses, zero recipe data across the boundary. See *Open questions*
for the resolution record.

Each guide kind surfaces only when its own toggle is on. A host guide
surfaces only when `/api` is on (the agent cannot act on it otherwise, and
surfacing it would re-pollute the context the user turned `/api` off to
avoid). Symmetrically, web guides surface only when `/web` is on. When both
are on, both surface — host first, web-guide after.

## Recipe drift mitigation

A prose web-guide degrades gracefully — an outdated hint still might help. A
declarative API recipe with a wrong endpoint or a rotated auth scheme **fails
hard and silently** — the agent gets a 401, can't tell if it's the guide or
the call, and has no fallback. `web-guides` doesn't need drift discipline
because prose is forgiving; recipes aren't.

v1 treats drift as a signal the agent reads, not a gate the loader enforces.
This matches host's core decision: move the call into a reviewed tool and let
the agent act on real signal rather than metadata. Forcing an arbitrary
expiration rejects guides that are still valid and adds maintenance churn
without catching drift the live response doesn't already expose. The agent is
capable of judging an out-of-date guide against an actual HTTP response —
that judgment is cheaper and more accurate than a date predicate.

- **`verified` date in recipe frontmatter, defaulted not enforced.** The
  field records when a guide was last verified against the live API. Missing
  `verified` defaults to the creation date (same as portal's `updated`
  default at `guides.ts:212`), so the vendored loader copies portal's behavior
  verbatim — no rejection logic, no fork. It is a record, not a gate.
- **`verified` date rendered in the guide-detail footer — no threshold, no label.**
  `api-guide({domain})` renders the guide's `verified` date alongside the
  current date in the detail footer, exactly as `web-guide` already renders
  `_Guide updated: … · Current date: …_`. No computed staleness label, no
  `N days` global threshold — the agent reads both dates *and* the live
  response and decides. This matches the doc's own thesis: an enforced date
  predicate rejects valid guides and adds churn without catching drift the
  live response doesn't already expose. A computed staleness label can come
  later only if agents misjudge in practice.
- **The live response is the actual drift signal.** A 401 on a no-auth
  guide, a 404 on a pinned path, a changed response shape — the agent reads
  those directly. The `verified` date is only predictive; the HTTP response
  is actual. Drift is not silent once the agent executes — the `verified`
  date surfaces it *before* execution, the response confirms it *during*.

This is the ranked risk the original doc under-weighted: recipe drift can
fail hard. But the mitigation is signal-rich (`verified` date + live response)
rather than gate-based, because the agent reading a real response is a
better drift detector than an enforced date.

## gatherAll ceiling

A misconfigured `gatherAll` against a 100k-item paginator is a self-DoS. The
ceiling is **per-guide-declared with a global fallback**, closed in v1:

- A guide declares `gatherAllMax: <N>` in frontmatter when the author knows
  the endpoint's real ceiling (e.g. an endpoint that maxes at 500 items).
- A global fallback cap applies when a guide doesn't declare one, so an
  undeclared guide can still self-DoS only up to the global cap, not up to
  the paginator's true limit.

Both values are specifics; the *policy* (per-guide first, global cap second)
is fixed now.

## Local user helpers (the legitimate executable-TS home)

For sites that need computed signatures, strange date transforms, or custom
auth flows that a declarative recipe can't express:

- Location: `~/.pi/agent/pi-lean-host/api-guides/<dirName>/helper.ts` (one
  helper per guide, living alongside the guide's `guide.md`). The directory
  name (`dirName`) is the guide identity the loader keys on; it may differ
  from the recipe's `domains:` key when one domain has multiple guides.
- Trust model: user-owned, loaded by domain, never in the npm tarball —
  sharing the *ownership* half of the stealth-backend model (user-owned,
  opt-in, not shipped, runs with the agent's privileges). But the *isolation*
  half is a **new profile**: stealth backends run as out-of-process Python
  subprocesses (process-level isolation — a backend crash is caught by the
  adapter and pi keeps running), while local helpers load via in-process
  `import()` with no process boundary. The residual is named below.
- **Authoring gate vs. execution gate.** Authoring a helper requires
  `/api learn` (the explicit opt-in, mirroring `/web learn`). Execution
  requires only `/api on` — a persisted helper runs on later sessions
  whenever a guide references it, even outside learn mode.
- A genuine escalation worth naming, not hand-waved: a persisted helper can
  make arbitrary network calls on later sessions. The mitigation is user
  ownership and review, not a sandbox.
- A user-authored guide references its guide's helper (one per guide directory);
  the agent picks an operation. In learn mode, the agent may also *author*
  a new helper for the current guide and persist it as `helper.ts` in the
  guide's folder.

### Execution: `import()` with a load/call guard, disable-on-failure

Helpers load via dynamic `import()` in-process. The load and the call are
both wrapped in `try/catch`: a top-level throw, a syntax error, a missing
dependency, or a throw during execution rejects the promise and is caught —
it does not crash pi. On any failure the helper is marked disabled for the
session and the user is notified via the same channel portal's toggle uses
(`pi.appendEntry("api-helper-status", ...)` or a status-bar slot). pi keeps
running; only that one helper is dead until the user fixes it and reloads.

The one case this guard **cannot** catch is a helper that registers a
*background* callback (`setTimeout`, `setInterval`, `process.on(...)`, an
event-emitter listener) and throws from that callback later — it escapes the
call frame and surfaces as a Node `uncaughtException` / `unhandledRejection`,
which can take pi down regardless of the guard. v1 accepts this residual on
purpose: the helper-author rule is **synchronous-pure or fully awaited, no
background work**. That covers every realistic v1 helper (format a query
string, sign a header, compute a date param). A user who needs a background
callback is writing code that can kill pi and is expected to know it — no
process-level handler is installed to save them. If a real keyed guide ever
needs background work, revisit then; do not pre-build it.

## Refactor boundaries (breakable vs not-breakable)

The package is pre-first-publish (0.5.0 targets the first `npm publish`),
so the *breakable* surface may be restructured freely to clean up the
implementation; the *not-breakable* list is the design, not backwards
compat, and carrying it through keeps the eventual keyed-API track
additive rather than a retrofit.

**Breakable — restructure freely during the refactor:**

- `restGet` / `paginate` / `parseResponse` internals and signatures.
- The pagination style set (`offset-limit` / `nextLink` / `cursor` / `page` /
  `resumptionToken` / `tokenBag`) — add, drop, or restructure styles.
- `responseShape` / `parse` fields and the `format` / `charset` / `accept`
  distinction.
- The local-helper contract signature (`(params, ctx) => params`).
- The `gatherAll` ceiling mechanics and per-op override shape.
- The transport layer (caching keys, 429/retry policy, redirect handling,
  charset decoding location).
- `resolveJsonPath` / `itemsPath` / cursor-path resolution semantics.

**Not breakable — these are the design, not backwards compat:**

- The **host-only boundary** (no `pi-lean-portal` / `pi-lean-search` import).
- **Bundled recipes are inert** — only files the user places in
  `~/.pi/agent/pi-lean-host/` execute; copying a bundled recipe is explicit
  opt-in. Recipes may carry `operation.helper: true` (with an accompanying
  `helper.ts` in the domain subdir) as worked examples; they do not execute
  until copied into the user's own dirs.
- **GET-read only** — no mutation helper.
- **Four tools, one side-effect boundary each** (`api-guide` local read,
  `api-fetch` network read, `api-learn` local write, `api-probe` network read
  gated to learn). Do not collapse them.
- The **`auth.kind` seam** (field + dispatch, `none` realized, others
  error). Dropping it to "simplify" burns the one thing the design built on
  purpose for the keyed track.
- The **`via: restGet | paginate` executor concept.** New executors may be
  added; the named-executor pattern stays.
- The projection boundary (host owns `ApiGuide`, portal sees `Guide` +
  `kind`); the additive-on / filter-off toggle contract.

## Scope discipline (what v1 is not)

- **No mutations.** GET-read only. Add `api-mutate` (or similar) only when a
  real *retrieval* guide needs it (e.g. a search-then-fetch POST), with a real
  auth-review gate — and that gate's foundation is the scoped secrets schema
  (deferred past v1; see *Secrets management*). A mutation needs not just
  "is this write-safe" but "do we have a write-scoped key". This is not a step
  toward general write/bot automation (see *Mission*).
- **Bundled recipes are inert.** Only files the user places in
  `~/.pi/agent/pi-lean-host/` execute; bundled recipes in
  `packages/pi-lean-host/api-guides/<domain>/` are reference material on
  GitHub, never in the npm tarball, never auto-loaded. A recipe may carry
  `operation.helper: true` (with an accompanying `helper.ts` in its domain
  subdir) as a worked example; it does not execute until the user copies
  the domain folder into their own dir. Agent-authored executable code is
  allowed, but only as local user helpers (`/api learn`, user-owned dir).
- **No inferred-link discovery.** Declared links only in v1; inference is v2.
- **No guide suppression.** Both guide kinds surface by domain match when
  their respective toggle is on; host-first ordering is a preference, not
  suppression.

## Risks, ranked

1. **Secrets handling — deferred past v1, but named so the future build is
   not lazy.** v1 ships `auth.kind: none` only and no secrets store (see
   *Secrets management*), so this risk is not realized in v1 code. It becomes
   first-class the moment a keyed guide lands: (a) at-rest — the Secret
   Service primary / file-fallback decision; (b) the transcript/output
   channel — every helper and every error branch that returns content to the
   agent must be airtight against exfiltration, since a 401 body echoed into
   a tool result leaks as surely as a logged key. Both threats are called out
   in *Secrets management* so the future build lands properly on both fronts.
2. **Recipe drift — hard failure.** A wrong endpoint or rotated auth scheme
   fails hard; the agent gets a 401/404 and can't immediately tell
   guide-failure from call-failure. Mitigated signal-first, not gate-based:
   a `verified` frontmatter date (defaulted, not enforced) is rendered
   alongside the current date in the guide-detail footer (no computed
   staleness label — the agent judges from the two dates, as it already does
   for `web-guide`), and the live HTTP response is the
   actual drift detector (see *Recipe drift mitigation*). The agent reads
   both and judges — cheaper and more accurate than an enforced expiration.
3. **Recipe-vs-code discipline** — the temptation to let bundled recipes
   auto-execute. The one discipline that, if broken, turns this into a
   sandbox problem. Enforced structurally: the loader only reads
   `~/.pi/agent/pi-lean-host/`, so nothing in `api-guides/` runs until the
   user copies it into their own directory and opts in.
4. **Glyph coordination across two independent toggles** — `/web` governs
   the `browser`/`search` slots; `/api` governs the `api` slot. Design the
   off-state defaults and visibility rules for both so the status bar stays
   legible whether one or both toggles are on.
5. **Local helper safety** — user helpers run with the agent's privileges and
   a persisted helper executes on later sessions whenever a guide references
   it, even outside learn mode. The *ownership* boundary is the one already
   accepted for user-installed stealth backends (user-owned, opt-in, not
   shipped); the *isolation* boundary is **new and weaker** — unlike stealth
   backends (out-of-process subprocesses, crash caught by the adapter), local
   helpers run in-process via `import()` with no process boundary, so a
   background-callback throw escapes as an `uncaughtException` and can take
   pi down (see *Execution: `import()`*). v1 mitigates with user ownership,
   a synchronous-pure-or-fully-awaited author rule, disable-on-failure for
   in-frame throws, and a visibility command (`/api helpers`) — not a sandbox.
   If a real keyed guide ever needs background work, revisit isolation
   (worker thread or subprocess) then.

## Open questions (deferred past v1)

Resolved during implementation — recorded here so they don't re-surface:

- **Escape-valve policy** — resolved; see
  [`api-helper-escape-valve.md`](./api-helper-escape-valve.md).
- **Guide recipe schema** — the concrete `operations[]` / `pagination` /
  `responseShape` / `auth` / `verified` / `gatherAllMax` block shapes and
  the authoring/validation behavior are specified in *Guide recipe schema*
  above. What remains is the `static-key`/`oauth2` auth strategy schemas,
  drafted when a real keyed guide lands.
- **`kind: "web" | "api"` field** — ships on the projection as an optional
  `Guide` field defaulting to `"web"`, carrying no recipe data, only a
  presentation-ordering hint for host-first surfacing. Whether a future
  *unified loader* (one parser, one map, both guide kinds) is worth building
  remains a post-v1 refactor driven by real co-install usage; the projection
  boundary (host owns `ApiGuide`, portal sees `Guide` + `kind`) makes it
  additive, not a retrofit.
- **`api-fetch` result return** — inline ~4000-char preview then spill to a
  temp file, mirroring `web-fetch`; the spill notice nudges `grep`/`read`
  and warns on very large responses.
- **`/api` command namespace** — `/api on|off|learn|status|helpers` (no
  `/api save`; `api-learn` writes directly to disk). `/api secrets` is not a
  v1 command — no store exists to manage; it arrives with the first keyed
  guide.

Still deferred past v1:

- Secret *entry* UX and the cross-platform secrets-library decision —
  both deferred (no store in v1); collected as the checklist for the first
  keyed-guide build in *Secrets management*.

## Relationship to existing packages

- **`pi-lean-portal`** — owns `/web`, its toggle (`toolset-state:pi-lean-dimension.web`
  via `pi-tool-masking`), the `SIBLING_TOOL_NAMES` union (search), guide
  discovery by domain, and the `browser`/`search` status-bar slots. Host does **not** join the `/web`
  sibling union — it is a peer package with its own `/api` toggle. Host
  reuses the **guide-discovery mechanism** (frontmatter + `domains` map) by
  **vendoring a minimal copy** of the ~100-line loader (see *Guide-loader
  ownership*), not by depending on portal. Host-only installs have no portal
  dependency. When co-installed, host registers a **projection** of its
  user-authored `ApiGuide`s (the only kind that load — bundled recipes are
  inert) with portal's **guide-source registry** so they surface in the
  navigate footer in browse mode (see *Guide file format: one file, two
  consumers* and *Discovery: two models keyed to the trigger*) — host→portal
  opt-in, never portal→host. Portal's surface change for v1 is one optional
  field (`kind?: "web" | "api"` on `Guide`) plus the registry array; no
  recipe-structured type crosses the boundary.
- **`pi-lean-search`** — the template for a thin sibling package that owns
  its own command (`/searxng-status`) and health probe while reusing the
  `/web` toggle. Host follows the same self-sufficient shape (own `/api`
  command namespace), but is a **peer** rather than a `/web` sibling because
  its toggle is independent.
- **`pi-lean-dimension`** — the umbrella meta-package; bundles host
  alongside portal + search.
- **Co-install matrix.** portal-only, host-only, and portal+host all work.
Portal is fully optional: host's core loop (authoring via docs/example +
direct-write verify, on-demand discovery, execution) runs with no portal
dependency. Portal unlocks two additive features when co-installed: browse-mode
reactive surfacing (via the guide-source registry) and probe-authoring for
undocumented APIs (via `web-fetch`). Neither is load-bearing for host-only
use. Inferred-link discovery — the one feature previously contemplated that
would have required *both* — is deferred to v2. Declared links,
user-authored guides, `api-guide`, and `api-fetch` work in any install configuration.

## Testing

Host maps cleanly onto the monorepo's existing "subject-under-test determines
location" principle. It introduces **no new test category** — host has no
browser, no `BrowserPlugin` interface, and no Python, so there is no contract
tier and no browser/behavioral tier. Everything host needs is already covered
by the **structural (mocked)** category, in `packages/pi-lean-host/__tests__/`,
run by a `test` script identical to search's (`vitest run`) and slotted into
the `test:ci` structural CI job.

| Host surface | Existing category | How |
|---|---|---|
| Guide parsing (frontmatter + prose — the "complex parsing" host owns) | Structural (mocked) | pure functions, vitest |
| `ApiGuide → Guide` projection (the registry projection) | Structural (mocked) | pure function, assert recipe fields stripped, presentation fields retained |
| Vendored `ssrfGuard` | Structural (mocked) | minimal SSRF guard; one smoke test confirms it blocks a private-IP / metadata-endpoint URL |
| `restGet` / `api-fetch` execute | Structural **with local server** | reuse `startTestServer()` from `packages/pi-lean-portal/__tests__/helpers/test-server.ts` — same pattern `fetch-backend` and `run-contributed-suites` already use for HTTP tools. No real network, no new infra. |
| `api-learn` write-to-disk | Structural (mocked) | tmpdir + assert file written, same as `web-learn` / `storage-state` tests |
| Local helper `import()` load/call guard and disable-on-failure | Structural (mocked) | point the loader at a fixture helper that throws, assert it is disabled and the host keeps running |
| Guide-source registry registration (when portal is co-installed) | Structural (mocked) | assert the projected `Record<string, Guide>` shape and host-first ordering |

### The one new assertion: the host-only boundary

Host's whole reason for vendoring `ssrf-guard.ts` and the ~100-line
guide-loader is the **host-only install property**: host must work without
portal present. That boundary is currently enforced by nothing — a stray
`import { X } from "../../pi-lean-portal/..."` would silently make host
depend on portal and only surface at install time in a host-only environment.

The cheapest guard is a single structural test asserting host's source graph
does not reach into `pi-lean-portal` (or `pi-lean-search`): walk
`packages/pi-lean-host/**/*.ts`, grep for portal/search import specifiers,
fail on any. One file, no framework — a new *assertion* in the structural
category, not a new category. Add that one test and stop.

### Deferred (not v1)

- No nock/msw or other HTTP mocking library — `startTestServer()` already
  covers the execute path against a real local socket.
- No contract-test runner — host is not a `BrowserPlugin`.
- No network/behavioral tier. When the first keyed-auth guide lands, add one
  real-API integration test behind a `HOST_INTEGRATION=1` opt-in gate,
  mirroring the existing `CONTRIB_RUN=1` pattern for contributed backends.
