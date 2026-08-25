# AGENTS.md — pi-lean-host (package)

> Declarative HTTP API client leaf of the
> [pi-lean-dimension](../../AGENTS.md) monorepo.
>
> For the suite overview and TypeScript quirks (nodenext `.js` imports,
> `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedModules`,
> `moduleDetection: force`), see [`../../AGENTS.md`](../../AGENTS.md). For the
> design docs, see [`docs/design/api-helper-escape-valve.md`](docs/design/api-helper-escape-valve.md).
>
> Note: the monorepo root `AGENTS.md` predates this package and does not yet
> list it — trust this file for host-specific commands and structure.

## What this package is

- Registers **5 tools**: `api-guide`, `api-fetch`, `api-learn`, `api-probe`,
  `api-scaffold`. `api-probe` is the shape-discovery tool for the authoring
  loop (fetch an exploratory path, summarize the JSON shape, emit a draft
  YAML op block); it never writes the guide. `api-scaffold` is the
  learn-gated bootstrap tool: it writes a starter `verify.json` (with
  `"__FILL_ME__"` sentinels for every unsatisfiable param) and/or a
  commented-out `helper.ts` stub into the `/tmp/pi-lean-host/<slug(shortName)>/`
  staging dir — never the guides dir. Refuse-to-overwrite on existing staged
  siblings; `verify.json` merge is additive (real values preserved, sentinels
  added for newly-unsatisfiable params); at least one of `verify`/`helper`
  must be `true`.
- Registers the **`/api`** command with
  `on|off|learn|status|helpers|secrets|verify|delete` subcommands — an
  independent peer toggle that composes freely with portal's `/web`
  (additive-on / filter-off semantics).
  - `/api verify <domain> [guide] [--force]` runs every runnable op of a
    guide against its live API and stamps `verified: today` into the guide's
    frontmatter **only when all runnable ops pass** (skips ≠ failures;
    transform failures are non-blocking). `--force` stamps without any HTTP
    (human-attested escape valve). Strict threshold: any partial/all-fail →
    no stamp. Opt-in params sidecar
    `~/.pi/agent/pi-lean-host/api-guides/<dirName>/verify.json`
    (`{ "<opName>": { "<param>": "<value>" } }`) supplies inputs for ops
    with unsatisfiable params (path `{token}` / required query with no
    default). Runs in **on** mode, not learn-gated, and not refused by the
    focus-mode guard (writes no toolset state). Shares the
    guide-resolution → helper → transform → auth → dispatch sequence with
    `api-fetch` via `core/resolve-op.ts` — one implementation, two call
    sites (don't duplicate it).
  - `/api delete <domain> [guide]` `rm -rf`s a guide directory **and**
    `invalidateCache()`s the per-session guide-store so the next
    `api-guide`/`api-fetch` doesn't see a ghost guide — the load-bearing
    reason this beats `bash rm`. Whole-domain = interactive confirm;
    single-guide (by shortName) = no confirm. Also always-available /
    not focus-guarded. The agent has **no** delete surface: `api-learn`'s
    collision/malformed errors tell it to ask the human to run this.
  - `/api secrets [domain [name]]` lists/provisions/deletes the per-domain
  secrets store (`core/secrets-store.ts`,
  `~/.pi/agent/pi-lean-host/secrets/<domain>.json`, 0600,
  lazy-mkdir-on-write-only). Names only, never values; headless
  invocation prints direct-file-write instructions; `--help` shows full
  usage + storage format (the bare list shows a one-line hint instead).
  `<domain>` assisted entry is guide-aware: a registered static-key guide
  declaring one secret name prompts its value directly, multiple show a
  picker, and the detail view surfaces declared-vs-stored gaps; `<domain>
  <name>` is the manual escape valve (warns when the name isn't a declared
  secret). `--delete` removes all secrets for a `<domain>` (interactive confirm) or
  a single `<domain> <name>` (no confirm).
  - `/api helpers`, `/api status`, and bare `/api` are read-only — the
    focus-mode guard does not apply to any of them, nor to `secrets`,
    `verify`, or `delete`.
- Manages the **`api` status bar glyph**, shown as `● api` when `/api` is on
  (colored by learn state) and `○ api` when off.
- Declares `pi-lean-portal` as an **optional peer dependency**. Host-only
  installs are valid. When co-installed, host registers a recipe-stripped
  `projectToGuide()` projection with portal's guide provider registry
  (runtime feature-detect — no static portal import) for surfacing in the
  navigation footer.

## Developer commands

There is no host-specific CI script; tests run via the monorepo vitest config
(`packages/*/**/*.test.ts`). Run from the **monorepo root**:

```bash
npm test                                              # all workspace tests, incl. host
npm run test:ci                                       # excludes chromium/firefox/bench; keeps host
npx vitest run packages/pi-lean-host                  # this package only
npx vitest run packages/pi-lean-host/__tests__/tools.test.ts   # one file
```

Host CI is **structural only** — fast, deterministic, no browser, no network.
Host's `api-guides/<domain>/` co-located tests are mocked-transport and
always-on (no env gate). Live-endpoint recipe tests are **not** hosted here;
they live in the [`caritas`](https://github.com/coreyryanhanson/caritas) repo, gated by its own `HOST_INTEGRATION=1`.

## Toggle states & focus-mode guard

`/api` has three states, mirroring portal's browser toggle:

- **on** — `api-guide` + `api-fetch` enabled (`api-learn` + `api-probe` +
  `api-scaffold` off)
- **learn** — on + `api-learn` + `api-probe` + `api-scaffold` (authoring mode)
- **off** — all five disabled

Starts **on**. Defaults are overridable via the `toolsetDefaults` settings tier
read by `pi-tool-masking`. The two `ToolsetSpec`s (defined in `core/api-toggle.ts`):

- `pi-lean-dimension.api` → `api-guide` + `api-fetch`, persistKey
  `toolset-state:pi-lean-dimension.api` (default `true`).
- `pi-lean-dimension.api-learn` → `api-learn` + `api-probe` + `api-scaffold`,
  persistKey `toolset-state:pi-lean-dimension.api-learn` (default `false`),
  `requires: ["pi-lean-dimension.api"]` — enabling learn cascades api on;
  disabling api cascades learn off. There is no `host.*` settings block;
credentials live in the per-domain secrets store, not `settings.json`.

**Focus-mode guard:** actuating subcommands (`on`/`off`/`learn`) are refused
while `pi-tool-masking` holds focus (inclusion mode or allowlist focus) — a
sibling toggle must not write a focus-indistinguishable `{enabled}` entry.
Read-only subcommands (`status`, `helpers`, bare `/api`) stay unguarded.

## Key architectural properties

- **Host-only boundary**: zero static imports from `pi-lean-portal` or
  `pi-lean-search`. Enforced by `__tests__/host-only-boundary.test.ts`.
  Portal integration is a runtime feature-detect (`registerPortalProjection()`),
  re-attempted on `session_start` in case host loads before portal.
- **One parser, two call sites**: `parseApiGuide()` validates before write
  (`api-learn`) and before use (loader). Don't add a second parser.
- **No mutations v1**: `via` accepts only `restGet` and `paginate`.
- **Two distinct transform mechanisms** — do not conflate:
  - **Built-in post-response transform** (gated): an op declares `transform: true`
    to run a named `transform(data, ctx)` export from its `helper.ts` after
    `parseResponse` (`restGet`) or per-item (`paginate`). Graceful by contract —
    a throw is caught per-call and the agent gets the raw data with a warning,
    never a disabled op (`paginate` routes failed items to a `failedItems`
    group; no item dropped). Cannot inspect response headers.
  - **Local user helpers** (`core/local-helpers.ts`): a **pre-call** transform.
    User-authored `helper.ts` lives alongside its guide at
    `~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts`, loaded on demand
    via dynamic `import()` when an op sets `helper: true`. It receives the
    agent-supplied params and returns the params the executor uses for URL
    templating / query assembly. One helper per domain is the v1 contract. A
    load failure or execution throw disables the helper for the rest of the
    session. See `api-helper-escape-valve.md` for the built-in vs local-helper
    classification.
- **Guide folder identity (`slug(shortName)` — 0.4.0 breaking change)**: a
  guide lives at `api-guides/<dirName>/guide.md` where **`dirName` must equal
  `slug(shortName)`**, never the routing `domain`. A divergent folder name — or
  an illegal/unslugable `shortName` (empty or all-symbol) — routes the guide to
  **malformed** and it never loads (enforced in the loader, `parse-api-guide.ts`).
  `api-learn`'s save derives the write target from the guide's own `shortName`
  (self-correcting), but an agent hand-writing a guide must not name the folder
  after the domain or it silently vanishes. `assertSafeDomain` (`path-template.ts`)
  rejects domains that could escape the guides dir via path traversal. A `slug()`
  throw is caught and routed to malformed, never escaped.
- **Multi-recipe domains**: a domain may claim multiple guides (each in its own
  directory, e.g. `internet-archive` + `wayback-availability`, both claiming
  `archive.org`). `buildDomainMap` is
  multi-valued (`Record<string, string[]>`); `api-fetch` resolves the operation
  by name across all matching guides (helper routed by **directory name**, not
  the routing `domain`); `api-guide` shows a disambiguation menu and accepts a
  `guide` selector. Optional `organization:` (catalog grouping) and
  `description:` (disambiguation summary) fields are recipe-slice only.
- **SSRF guard** (`core/ssrf-guard.ts`): blocks loopback, private RFC1918
  ranges, and cloud metadata endpoints on **server-supplied** `nextLink` URLs
  in `paginate` only. Agent-supplied `restGet` URLs are **not** guarded (the
  agent has bash).
- **Static-key auth** (`core/auth.ts` + schema): `auth.kind: static-key`
  realizes `secretRefs` (`Record<headerName, secretName>`), `headerPrefixes`
  (`Record<headerName, prefix>` — store holds the raw credential; the guide
  declares the scheme prefix e.g. `Authorization: "Bearer "`, applied at
  resolution time; every key must be a `secretRefs` header, parser-enforced),
  `secretQueryRefs` (`Record<paramName, secretName>`), `requires: string[]`,
  `optional: string[]`.
  - **Parser-enforced invariants**: ref values and `requires ∪ optional`
    must coincide (every ref targets a declared secret and vice versa); a
    name in both is an error; a `secretQueryRefs` param colliding with any
    op's `params` map is an error; `oauth2` is rejected at parse.
  - **Injection**: `api-fetch` resolves store secrets via
    `resolveSecretHeaders()` / `resolveSecretQueryParams()` and injects them
    in code — the value never enters agent context. A missing `requires`
    secret **fails closed before the request**; `optional` absent proceeds
    unauthenticated.
  - **Store key is decoupled from routing domain**: `canonicalStoreDomain(guide)
    = guide.domains[0]` (`core/auth.ts`), applied at the `api-fetch` call
    site — so `/api secrets github.com` feeds a guide whether the agent
    routed it as `github.com` or an api-subdomain alias.
  - **`api-probe` store resolution** (no `guide` object): defaults to
    `hostnameOf(apiHost)`, falling back to the longest provisioned parent
    domain (`pro-api.coinmarketcap.com` → `coinmarketcap.com`) before
    declaring a secret missing; overridable via an agent-visible `domain`
    param. Store-miss fetches unauthenticated with a prescriptive note
    (names provisioned domains + "pass domain: <one>") — never fail-closed.
  - **Auth forces the SSRF-checked redirect path**: `hasAuth` (any non-accept
    header ∨ injected query secret) sends the call through the transport's
    guarded-redirect path, so auth-bearing calls are SSRF-checked hop-by-hop
    and store-injected headers + `Authorization` are stripped on
    **cross-domain** redirect hops (literal `auth.headers` survive).
  - **Output-channel audit** (don't regress): known secret values are
    scrubbed from 401 error bodies (`checkResponseStatus`) and from
    `details.headers` on auth-bearing `restGet`; query-param secrets are
    injected **below** the agent params map (never into it) and redacted to
    `?param=***` on every surfaced URL (`result.url`, `PaginateResult.urls`
    incl. server-supplied `nextUrl`, and the URL stored on `HelperError.url`).
    Shared `authStatusLine()` footer renders five metadata-only states on
    both `api-guide` and `api-fetch` (no-auth / ok / nudge-provision /
    ok-optional / optional-not-provisioned).
  - **`api-probe` extras**: inline `auth` block (injection fields only) for
    probing auth-gated endpoints; learn-gated `listSecrets: true` lists
    provisioned secret names (names only) to close the authoring bootstrap
    gap. A bare `listSecrets` call (no `domain`, no `apiHost`) lists
    **provisioned-but-guideless** (unscoped) store domains first — the orphan
    view for authoring bootstrap + post-flip migration cleanup — then the
    per-domain view.
  - **Deferred by design** (don't add): `oauth2` stays a
    declared-but-unrealized seam (rejected at parse); general mutations /
    write gate stay out (transport is GET-only); cookie-login (jar +
    `api-login`) is deferred in full; an OS-keychain at-rest backend
    (`@napi-rs/keyring`) is an additive store-backend upgrade, daemon-gated
    on headless so the `0600` file stays the honest default. No `scopes`
    schema — read-only is enforced structurally (only GET
    `restGet`/`paginate`), scoping is behavioral (provision read-only keys).
- **Response spill** (`core/response-spill.ts`): when `api-fetch` truncates,
  the full JSON is spilled to disk (max 8 files/session, oldest evicted;
  `cleanupAllSpill()` on `session_shutdown`).

## Files

- `index.ts` — entry. Resets module singletons (`resetToggleModuleState`,
  `resetDisabledHelpers`) on every invocation so `/resume` re-loads are
  idempotent — pi reuses the cached extension factory and re-invokes this
  function with the same module-level state.
- `core/` — `api-guide-types.ts` (recipe schema types, `ParseError`,
  `GATHER_ALL_MAX_FALLBACK`), `parse-api-guide.ts` (the parser +
  `projectToGuide()` + `loadApiGuidesFromDir()` + `formatApiGuideCatalog()`),
  `guide-loader.ts` + `guide-store.ts` (multi-valued domain map,
  `findGuidesByDomain` returns `{ guide, dirName }[]`, `invalidateCache()`),
  `resolve-op.ts` (shared guide→helper→transform→auth→dispatch sequence for
  `api-fetch` + `/api verify` — one implementation, two call sites),
  `guide-picker.ts` (TUI `SelectList` for N-guide `/api verify` + `/api delete`,
  headless falls back to text menu), `helpers.ts` (built-in executor helpers),
  `local-helpers.ts` (user helper loader), `helpers-command.ts` (`/api helpers`),
  `secrets-store.ts` (per-domain secrets store — swappable `SecretStore`
  interface, 0600 file backend, lazy-mkdir-on-write-only, single-key +
  whole-domain delete), `secrets-command.ts` (`/api secrets`),
  `verify-command.ts` (`/api verify` — strict-threshold live verify +
  `verified:` stamp, `--force`, `verify.json` sidecar),
  `verify-stamp` logic lives in `parse-api-guide.ts` (`stampFrontmatterField`),
  `delete-command.ts` (`/api delete` — `rm -rf` + `invalidateCache()`),
  `auth.ts` (static-key secret resolution + shared auth-status footer),
  `transport.ts` (shared fetch pipeline: UA, charset, 429-retry, ETag cache —
  the sanctioned way to reach even WAF'd hosts), `path-template.ts`,
  `ssrf-guard.ts`, `status-hint.ts` (shared 403 classifier — `serverMessage`
  extracts the server's reason, `isPlanGated` flags plan/subscription
  limitations; one implementation used by both `api-probe` and
  `api-fetch`/`/api verify`), `response-spill.ts`, `api-toggle.ts` (`/api` toggle —
  dispatches all 8 subcommands), `portal-projection.ts`,
  `verify-ship-manifest.ts` (vendored host-only copy of the portal utility).
- `tools/` — `api-guide.ts`, `api-fetch.ts`, `api-learn.ts` (directory-level
  staged-file authoring: `{domain, new: true}` → fresh template; fetch-recipe
  stages `guide.md` + present `helper.ts`/`verify.json` siblings to
  `/tmp/pi-lean-host/<slug(shortName)>/`; save takes a `dir` (staged dir path)
  plus an undescribed `confirmDeletions`, reads every staged file and
  **mirror-saves** it to `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/`
  — the `domain` arg is cosmetic on save, the target is self-keyed by the
  guide's `shortName`. A deletion-safety gate refuses unconfirmed sibling
  wipes (staged sibling absent → doomed; `confirmDeletions: true` re-call
  proceeds); save-time guide↔helper validation refuses a guide declaring
  `helper: true` / `transform: true` without a loadable staged `helper.ts`
  (self-contained, no `core/local-helpers.ts` export)), `api-scaffold.ts`
  (see above), `api-probe.ts`, `utils.ts`, `index.ts`.
- `__tests__/` — framework structural tests (no network): `smoke`,
  `parse-api-guide`, `all-guides-parse` (every bundled `guide.md` parses
  cleanly), `tools`, `api-learn-fetch-recipe` (fetch-recipe + entry-point
  split + N-guide disambiguation + file staging), `helpers`, `local-helpers`,
  `api-toggle`, `api-scaffold`, `api-learn-multi-file` (multi-file staging,
  mirror-save, deletion gate, guide↔helper validation),
  `secrets-store`, `secrets-command`, `auth` (static-key schema/injection/
  output-channel audit/SSRF/footer structural tests), `query-secrets`
  (query-param-secret injection, output-channel redaction, api-probe inline
  auth / `listSecrets`), `portal-projection`, `render-result`,
  `response-spill`, `host-only-boundary`, `axis-units` (nextLink/XML/cursor/
  ETag via mocked transport; fixtures in `__tests__/fixtures/axis/`),
  `axis-coverage` (regression tripwire: the synthetic axis-guide set's union
  covers every guide-driven axis — removing an axis guide or dropping an
  axis-exercising op fails it), `schema-version` (metadata-only guard on
  `schemaVersion` frontmatter), `transform-{restget,paginate,render}`,
  `transport` (A3 Retry-After HTTP-date / exponential-backoff parsing — no
  recipe can reliably force a 429, so the unit test is the proof),
  `api-probe`, `verify-command` (mocked-transport: strict threshold, auth
  precheck, param precheck, `verify.json`, helper-disabled skip),
  `status-hint` (shared 403 classifier: server-message extraction +
  plan-gating detection),
  `verify-stamp` (frontmatter-isolated `verified:` edit, `--force`),
  `delete-command` (ghost-guide cache fix), `guide-picker` (TUI gate + row
  mapping), `ship-manifest` (tarball coverage + asserts `api-guides/` is
  excluded from the npm tarball). Fixtures: `__tests__/fixtures/{axis,mediawiki,oai}/`.

## api-guides/ — synthetic axis guides (framework fixtures)

`api-guides/<domain>/` holds the **synthetic axis-guide set** — minimal
coverage fixtures that keep every guide-driven framework axis exercised
inside host. They are **framework fixtures, not real recipes**: no
`verified:` date, no live endpoints, and every co-located test runs against
**mocked transport** (always-on, no env gate). This is what lets host stay
"green by construction" — the framework is still proved without the real
recipe library. Like all of `api-guides/`, they're excluded from the npm
tarball (repo-only); the tests read them from disk.

The membership is set by the axis-set audit (its matrix is encoded in
`__tests__/axis-coverage.test.ts`). That test is the regression tripwire
that pins the set: the kept union must cover every axis and the guide count
must match. Co-located mocked-transport tests live only for
axes **not** consolidated into `__tests__/axis-units.test.ts` (local-helper,
transform, static-key-auth, multi-recipe-domains, resumptionToken, tokenBag).
No `_shared/`, `WAF-NOTES.md`, or `CONTRIBUTING.md` remain here — those moved
to caritas along with the real recipes.

The inline `api-learn({domain, new: true})` placeholder skeleton (a
fail-closed starter template — only `domains` real, other fields `<placeholder>`)
stays in host as a self-contained authoring aid, separate from the full
reference recipes in caritas.

For the **comprehensive recipe library** (real endpoints, live tests, per-recipe
`verified:`-date drift disclaimer), see the
[`caritas`](https://github.com/coreyryanhanson/caritas) repo. It owns the drift
disclaimer; host ships only the synthetic axis fixtures.

### Guide schema versioning

`core/api-guide-types.ts` exports `GUIDE_SCHEMA_VERSION` (currently `0`,
beta). `schemaVersion` is **breaking-change detection**: `api-learn` stamps it
on save (each guide records its authoring vintage), absent-on-read defaults
to `0` (the floor, not current), and a stale guide (`schemaVersion <
current`) gets a **non-blocking `⚠` warning** in the `api-guide` catalog /
detail / disambiguation and a note on `api-fetch`. **Never a gate** — the
guide always loads and runs (proved by `__tests__/schema-version.test.ts`).
At the lockstep release it bumps to `1` (the frozen-beta label change) with
a CHANGELOG line.

**Bump rule (post-v1):** do not bump unless a guide that used to parse now
fails to parse. Adding an optional field, a new enum value, or relaxing a
constraint is a non-event; removing/renaming a field, deleting a
`via`/`pagination.style` value, or changing a parse-enforced constraint's
meaning — those bump. Each v2+ bump is one CHANGELOG line.
