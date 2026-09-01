# Changelog

## [Unreleased]

### Added

- **`pi-lean-host` — declarative REST API client package** — a new
  workspace package giving the agent
  recipe-based access to REST APIs. A guide is one markdown file with
  YAML frontmatter (`guide.md`) declaring an API's host, endpoints,
  auth, pagination, and response shape; a fixed executor runs the
  declared operation so an API encoded once is reusable forever, not
  re-derived each session. Guides live at
  `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/` and only files you
  place there execute — bundled recipes are inert reference material.
  Ships 7 tools (`api-guide`, `api-fetch`, `api-learn`, `api-probe`,
  `api-scaffold`, `api-store`, `oauth-mint`)
  and the `/api` command. The package declares `pi-lean-portal` as an
  **optional peer dependency** — host-only installs are valid.
- **`/api` toggle — independent peer of `/web`** — `on|off|learn|status`
  plus `helpers`, `secrets`, `verify`, `delete`, `oauth`, and `bootstrap`
  subcommands. The two
  toggles compose freely: each owns its own toolset and status-bar glyph, and
  `/api on` + `/web off` yields a pure **api-only** context with zero
  `browser-*` noise for batch structured-data pulls. Three states
  (`on`, `learn`, `off`) with the authoring tools (`api-learn`,
  `api-probe`, `api-scaffold`, `api-store`, `oauth-mint`) gated behind
  `learn`; starts **on**. State persists via `pi-tool-masking`
  (`persistKey: toolset-state:pi-lean-dimension.api` / `.api-learn`),
  with defaults overridable through the `toolsetDefaults` settings tier.
  Actuating subcommands are refused while a focus mode is active
  (read-only subcommands stay unguarded), mirroring the portal/search
  focus-mode guard. `/api verify <domain> [guide] [--force]` runs every
  runnable op against the live API and stamps `verified` on success
  (any runnable-op failure → no stamp; skipped ops named; `--force` is
  human-typed only); `/api delete <domain> [guide]` removes a guide
  directory and invalidates the guide-store cache (human-typed recovery
  gesture, no agent tool surface). `/api oauth <domain> …` (init / mint /
  `--status` / `--refresh` / `--revoke` / `--code <code>` per token slot)
  manages OAuth2 tokens.
- **Recipe schema and fixed executor** — `via: restGet|paginate` per
  operation; `responseShape.format: json|xml|text` with an IANA
  `charset` fallback (header charset always wins). Six pagination styles
  cover the recipe-library axes: `offset-limit`, `page`, `nextLink`,
  `cursor`, `resumptionToken`, `tokenBag`, with optional
  `totalCountPath` for a server-reported total. `gatherAll` paginates
  to exhaustion under a per-guide / per-op `gatherAllMax` ceiling
  (default `1000`). Op-level `requiresAnyOf` declares an at-least-one-of
  param group (single group per op, v1). `schemaVersion` frontmatter
  (stamped on save by `api-learn`) drives breaking-change detection: a
  stale guide warns non-blockingly in `api-guide`/`api-fetch`, never
  gating the load. v1 is **GET-read only** — no mutation helper.
- **`api-learn` + `api-probe` + `api-scaffold` authoring loop** — `api-learn`
  stages the working copy to `/tmp/pi-lean-host/<domain>/` for starter
  templates (`new: true`) or `/<slug(shortName)>/` for fetched recipes, and
  saves from a staged **directory** (`dir`), so the model never round-trips a giant
  recipe string. `domain` is required: `{domain, new: true}` stages a
  fail-closed starter template (only `domains` is real; the rest are
  `<placeholder>` values that reject until filled), and `{domain}` fetches an
  existing guide's raw recipe **and its present siblings** (`helper.ts`,
  `verify.json`) into the staged dir (surfacing `dirName` to prevent
  sibling-clobber in multi-recipe domains). The authoring manual (field
  reference + defaults + semantics) is prepended to every staged pull so the
  author sees it at the moment of authoring. On save, a **mirror-save**
  overwrites present staged files and a **deletion-safety gate** refuses
  unconfirmed sibling wipes (a sibling in the guides dir but absent from the
  staged dir → refusal naming the doomed files; re-call with the undescribed
  `confirmDeletions: true` to proceed); save-time **guide↔helper validation**
  refuses a guide declaring `helper: true`/`transform: true` without a
  loadable staged `helper.ts`. A fail-closed overwrite guard refuses to
  replace an existing `guide.md` whose `shortName` differs from the incoming
  guide (prevents clobbering a sibling in a multi-recipe domain); a
  same-`shortName` save is a legitimate update. `api-scaffold` bootstraps the
  two artifacts the loop can't draft from the recipe: a starter `verify.json`
  with `"__FILL_ME__"` sentinels for every unsatisfiable param (additively
  merged into an existing guides-dir `verify.json`) and/or a commented-out
  `helper.ts` stub — written to the same staged dir, never the guides dir,
  refuse-to-overwrite on existing staged siblings. `api-probe` fetches a
  templated path over the real transport, summarizes the JSON shape, and
  emits a draft YAML
  operation block — it only suggests, never writes. On 404 it walks the
  `apiHost` version backward to recover an over-claimed version; on 403
  with auth injected it surfaces the server's own (scrubbed) reason
  rather than a false "verify header" signal. A reserved-YAML-char
  pre-scan lists every plain-scalar value starting with a backtick, `%`,
  `@`, or comma at once, so a multi-offender frontmatter costs one
  save/validate cycle instead of one per line. Authoring is spec-first,
  probe-second; the agent never authors guides unprompted outside
  `/api learn`.
- **Auth: v1 union schema and per-domain secrets store** — `auth.kind` is
  a `NoneAuth | StaticKeyAuth | OAuth2Auth` discriminated union and every
  secret reference is a nested `SecretRef` — `{ secret, prefix?, optional? }`,
  where `secret` is the store name, `prefix` is prepended to the resolved
  value at fetch time (e.g. `Authorization: "Bearer "`), and `optional: true`
  means absent → proceed unauthenticated (otherwise the ref is hard-required
  and absent → `api-fetch` **fails closed before the request**). Availability
  and prefix are properties of each ref — the old flat rosters
  (`requires`/`optional`/`headerPrefixes`) are gone. `static-key` realizes
  `secretRefs` (header injection) + `secretQueryRefs` (query-param injection,
  collision with any op's `params` rejected at parse); `oauth2` is realized
  at runtime (see the OAuth2 bullet below). Guides authoring against earlier
  snapshots of the flat shape should be migrated per
  `docs/migration-v1.md`. `api-fetch` resolves and injects values in
  code — the value never enters agent context. Secrets persist at
  `~/.pi/agent/pi-lean-host/secrets/<domain>.json` (mode `0600`,
  lazy-mkdir-on-write-only), provisioned transcript-safely via
  `/api secrets` (names only, never values; headless hosts get direct
  file-write instructions). An output-channel audit scrubs both the
  prefixed and raw forms of a secret value from 401 bodies and
  `details.headers`, redacts query-param secrets to `?param=***` on
  every surfaced URL, and forces any auth-bearing call through the
  SSRF-guarded redirect loop with injected secrets stripped on
  cross-domain hops. An OS-keychain at-rest backend is deferred (the
  `0600` file stays the honest default).
- **OAuth2 token flows and `api-store` inspection** — `auth.kind: oauth2`
  is realized: `client_credentials` mints/caches/lazily-refreshes via
  `resolveAccessToken` (per-slot lock + skew buffer), and the auth-code
  flow is headless paste-based (authorize URL printed, the user consents
  in their own browser and pastes the redirect URL back — RFC 8252 §7.3
  `http://127.0.0.1/callback` convention). Token slots are keyed by
  `(storeDomain, grant, tokenUrl)` so one domain can hold multiple grants
  and issuers without clobbering. `/api oauth` init / mint / `--status` /
  `--refresh` / `--revoke` / `--code <code>` per slot (human-typed);
  `/api bootstrap oauth <domain> <spec>` injects an agent-driven research
  brief; `oauth-mint` is the learn-gated human-in-the-loop mint tool (the
  agent supplies researched params; the human confirms the token URL, picks
  scopes, and pastes the redirect URL — it never enters the transcript).
  The learn-gated `api-store` tool is the agent's read-only combined view
  of both credential stores: bare call → orphan view (unscoped secret
  domains + guideless token domains); with a domain → provisioned vs
  declared vs gap secret names, token slots (issuer, granted scope, expiry,
  refreshable), and declared-slot gaps pointing at `oauth-mint` — metadata
  only, values never leave the stores.
- **Local user helpers** — a `helper.ts` alongside a guide runs
  in-process via `import()` under a load/call guard that disables the
  helper for the session on any in-frame throw (pi keeps running). The
  pre-call contract `(params, ctx) => params` reshapes the request; an
  optional gated `transform(data, ctx)` named export runs post-response
  when an op declares `transform: true` (graceful — a throw returns raw
  data, never disables the op). One helper per domain is the v1
  contract; a failed helper is surfaced via `/api status` and the
  status-bar glyph.
- **Shared transport, SSRF guard, and response spill** — a per-domain
  undici `Agent` with a fixed UA, 429-retry (Retry-After HTTP-date /
  exponential backoff), redirect policy, and ETag/`Cache-Control`
  caching is the sanctioned way to reach even WAF'd hosts. The SSRF
  guard (`core/ssrf-guard.ts`) blocks loopback, private RFC1918 ranges,
  link-local, and cloud-metadata endpoints on **server-supplied**
  `nextLink` URLs only (agent-supplied `restGet` URLs are not guarded —
  the agent has `bash`); it is now load-bearing under keyed auth. When
  `api-fetch` truncates, the full JSON spills to disk (max 8 files per
  session, oldest evicted; cleaned on `session_shutdown`).
- **Multi-recipe domains and host-only boundary** — a domain may claim
  multiple guides (each in its own directory); `api-guide` shows a
  disambiguation menu and accepts a `guide` selector, `api-fetch`
  resolves the operation by name across all matching guides, and
  optional `organization:` / `description:` fields aid catalog grouping
  and disambiguation. Host has **zero static imports** from
  `pi-lean-portal`/`pi-lean-search` (enforced by a boundary test); a
  runtime feature-detect registers a recipe-stripped projection with
  portal's guide-source registry when co-installed, re-attempted on
  `session_start`. Portal's receiving side ships in this same release:
  peer api-kind projections are namespaced (`api:<name>`) so a
  same-named user web guide can't clobber them, a guide declaring only
  the apex domain (e.g. `coingecko.com`) surfaces on `www.`/subdomain
  navigations, the guide footer groups API guides before site guides
  and routes each to `api-guide({domain, guide: "<shortName>"})`
  instead of `web-guide`, and `web-guide guide=` lists the available
  guides grouped under an `API guides:` section. A domain can have
  both a web guide and one or more API guides, all discoverable.
- **Synthetic axis-guide fixtures** — `api-guides/<domain>/` holds a
  minimal coverage set (no `verified:` date, no live endpoints) that
  keeps every guide-driven framework axis exercised via mocked
  transport, pinned by `__tests__/axis-coverage.test.ts`. They are
  framework fixtures excluded from the npm tarball, not recipes to
  copy; a more comprehensive recipe library lives in the separate
  `Caritas` repo.

### Changed

- **`web-fetch` 4xx failures now suggest `browser-navigate`** — when a
  plain HTTP fetch is rejected with a 4xx status (bot/UA gates, auth
  walls), the tool result appends a tip to steer the agent toward
  `browser-navigate`, which a real browser often passes where a bare
  fetch is refused. 404s are exempt (a browser hits the same wall) and
  5xx is out of scope (server-side, not a fetch-vs-browser gap).
- **Crash events now surface in navigate results** — `DialogEvent`
  gained a `"crash"` type and `handledAs` became optional (absent for
  non-dialog events). The router renders these under a renamed
  "Page events (dialogs, crashes)" footer with a 💥 prefix, so agents
  learn about page crashes the same way they learn about auto-dismissed
  dialogs.

### Fixed

- **Reserved-char pre-scan is now block-scalar aware** — `parse-api-guide`'s
  frontmatter pre-scan for plain scalars starting with a reserved YAML
  character no longer misreads the continuation lines of a folded/literal
  block scalar (`description: >`) as `key: value` pairs. Guides whose
  `description: >` blocks contain markdown backticks (e.g. arXiv's
  `` `all:` `` field prefixes) were being rejected as malformed even though
  the YAML parsed cleanly; they now load normally. Genuine plain-scalar
  offenders are still flagged in one pass.

## [0.4.0] - 2026-08-02

### Changed

- **Settings-based toolset defaults now read by `pi-tool-masking`** — the
  `toolsetDefaults` block in `settings.json`
  (`toolset-state:pi-lean-dimension.web`, `.web-learn`, `.search`) is now read
  by the `pi-tool-masking` library at restore time, between the chat-branch
  tier and the toolset's packaged default. The legacy
  `browserToggle.defaultEnabled` key is **removed** — users who pinned it
  should add the matching `toolsetDefaults` entry (the 0.3.3 migration
  warning prepared this). Focus guards in `pi-lean-portal` and
  `pi-lean-search` now use the typed `allowlist` resolution mode instead of
  string casts. `pi-tool-masking` bumped to `^1.2.0`.

## [0.3.3] - 2026-08-01

### Added

- **Migration warning for `browserToggle.defaultEnabled`** — `pi-lean-portal`
  now warns on `session_start` when the legacy `browserToggle.defaultEnabled`
  key is present in `settings.json`. Settings-based toolset defaults are being
  offloaded to the `pi-tool-masking` library, which reads a new
  `toolsetDefaults` block keyed by persist key
  (`toolset-state:pi-lean-dimension.web`, `.web-learn`, `.search`). The legacy
  key is still honored for backward compat until the offload lands; the warning
  shows the new shape so users can migrate before the legacy read is removed.
  Once the `toolset-state:pi-lean-dimension.web` entry is present in
  `toolsetDefaults`, the warning is suppressed even if the legacy key is still
  on disk — the migration target exists, so the nudge is redundant. The root
  and portal READMEs now mark `browserToggle.defaultEnabled` as deprecated at
  each reference and show the forward-compatible `toolsetDefaults` shape.

### Fixed

- **Focus-mode guards in `pi-lean-portal` and `pi-lean-search`** — `/web` actuating
  subcommands (`on`/`off`/`learn`) and the search co-activation mirror now refuse to
  modify toolset state while an allowlist focus is active, alongside the existing
  inclusion guard. Prevents a focus-resume bug where a consumer mirror wrote a
  focus-indistinguishable `{enabled}` entry on resume, corrupting the persisted
  branch across sessions. The guards read the shared `globalThis` resolution-mode
  state (a string cast bridges the unpublished `"allowlist"` mode until
  `pi-tool-masking@1.2.0`) and are a no-op on published versions where nothing
  writes that mode. Bumped the `pi-tool-masking` dependency range to `^1.1.0`.

## [0.3.2] - 2026-07-26

### Fixed

- **`pi-tool-masking` now ships as a regular dependency** — it was
  incorrectly declared as a `peerDependency` in `pi-lean-portal` and
  `pi-lean-search`, but unlike the `@earendil-works/*` and `typebox`
  peers it is a standalone package the pi runtime does not provide.
  npm does not auto-install peers on global/transitive installs, so a
  clean `pi` install failed to load both extensions with
  `Cannot find module 'pi-tool-masking'`. Reclassifying it as a
  `dependency` lets npm hoist it to a single deduped instance
  (preserving the singleton `TOOLSET_EVENTS` contract) on every install
  path. The umbrella `pi-lean-dimension` package needs no change — it
  pulls the dep transitively through its bundled children.

## [0.3.1] - 2026-07-26

### Changed

- **Renamed toolset IDs to a namespaced scheme** — the three toolset
  identifiers are now `pi-lean-dimension.web` (was `portal.web`),
  `pi-lean-dimension.web-learn` (was `portal.learn`), and
  `pi-lean-dimension.search` (was `search.web`), with `toolset-state:`
  persist keys following suit. The old names were generic enough to risk
  colliding with third-party plugin toolsets; the package-name prefix
  reserves the namespace and keeps co-activation wiring unambiguous.
  Existing persisted toggle state under the old keys is not migrated — a
  session branched before the rename re-resolves to defaults.

## [0.3.0] - 2026-07-26

### Added

- **Documented user-guide override of builtins** — a same-named `.md` in
  `~/.pi/agent/pi-lean-portal/web-guides/` (e.g. `bot-detection.md`) shadows
  the builtin guide entirely: whole-guide replacement, not field merge. The
  README and `AGENTS.md` now spell out the override semantics, the
  `trigger.signal` requirement to keep a pattern guide firing after override,
  and that site guides and pattern guides live in disjoint namespaces (a site
  guide for `www.botdetection.com` does not collide with the `bot-detection`
  pattern). Tests pin all four override cases.

- **Pinned Camoufox CI stack via `pin.json` sidecar** —
  `contributed/camoufox-py/pin.json` is now the single source of truth for
  the `cloverlabs-camoufox` package (`==0.6.0`) and fetched binary
  (`official/152.0.4-beta.28`) the `contributed` job runs against. CI reads
  both with `jq` before the Python venv exists. The Camoufox bridge runs an
  advisory `_check_pinned_version()` at launch that warns to stderr on
  package or binary drift but never raises. `contributed/README.md`
  documents the pin and a 4-step upgrade procedure; user-facing install
  instructions stay unpinned so local users track latest.

- **`workflow_dispatch` input toggles** — `ci.yml` gains `miniwob` and
  `contributed` boolean inputs (both default `false`). A manual run with
  both off now runs only `structural`; `miniwob` stays on for every push/PR,
  and `contributed` stays manual-only but now requires its input toggled on
  instead of firing on any dispatch.

### Changed

- **Removed the portal URL guard** — `core/shared/url-safety.ts` and its
  tests are deleted; `browser-navigate` and `web-fetch` no longer reject
  localhost, private-IP, non-http(s) schemes, or secret-bearing URLs. The
  guard was an SSRF-style boundary that doesn't fit a coding agent with
  filesystem `bash`/`read`/`write` already in scope — it patched one hole in
  a sieve. The malformed-URL `new URL()` parse at both call sites stays
  (input validation, not a guard), so `webFetch({ url: "not a url" })` still
  returns `{ success: false, error: "Invalid URL" }`. The portal
  `AGENTS.md` constraint listing the guard is dropped.

- **Guide footer names the `web-guide` invocation** — `formatGuideFooter`
  now appends `(web-guide guide="<name>")` to each listed guide so the
  agent can call `web-guide` with the exact guide key instead of guessing
  from the short name.

- **Camoufox scroll quirk reversed for the current binary** —
  `_scroll_via_wheel` now defaults to `False` (eval-based
  `window.scrollBy`). On `152.0.4-beta.27+` the patched Juggler no-ops
  `page.mouse.wheel` (the `wheel` listener never fires), while the
  eval-write path that silently no-op'd on the legacy `135.0.1-beta.24`
  binary now works. The Camoufox template drops its `True` override; the
  base default is unchanged for shipped `chromium-py`/`firefox-py` (both
  already `False`).

- **Contributed test suites force `launch.humanize=false`** —
  `run-contributed-suites.test.ts` and `miniwob-user-backends.test.ts`
  override `humanize` to `false` for every discovered backend. Camoufox's
  humanized-click motion (~1.5s bezier) makes `locator.click(timeout=5s)`
  flake and exceeds MiniWoB's ~10s task budgets; the suites exercise the
  backend *contract*, not human-emulation, so the override is test-mode
  only. Real users keep the `humanize=True` default.

- **Breaking (Python bridge API):** the abstract `BrowserBridge` class in
  `pi_browser_bridge/bridge.py` has been folded into its only subclass
  `PlaywrightBridge` in `playwright_base.py`. `bridge.py` is deleted and the
  module no longer exports `BrowserBridge`. User-installed stealth backends
  that subclassed `BrowserBridge` must now subclass `PlaywrightBridge`
  instead — the Camoufox template was already on `PlaywrightBridge`, so
  shipped examples are unaffected.

- **Breaking (toggle state persistence):** the `/web` toggle's persisted
  branch state moved from a single `web-toggle-state` entry (shape
  `{ browserToolsEnabled, learnToolsEnabled, defaultProfile }`) to three
  separate keys: `toolset-state:portal.web` (`{ enabled }`),
  `toolset-state:portal.learn` (`{ enabled }`), and
  `portal-conversation-state` (`{ defaultProfile }`). In-flight sessions
  that stored the legacy `web-toggle-state` shape are not found by the new
  restore logic — on upgrade to 0.3.0 the toggle resets to defaults and
  any conversation-scoped profile override is lost. No migration is
  performed; the schema break is intentional, part of moving the low-level
  masking logic into the shared `pi-tool-masking` package (see Internal).

### Internal

- **Toggle masking offloaded to `pi-tool-masking`** — the low-level
  active-set masking logic that lived in `browser-toggle.ts`
  (`applyBrowserState`, `applyLearnState`, `SIBLING_TOOL_NAMES`, the
  peer-tool union math) is replaced by the shared `pi-tool-masking`
  package's `defineToolset` / `defineToolsetPeer` / `TOOLSET_EVENTS` API.
  Portal now owns only command dispatch, glyph rendering, and profile
  persistence; toolset state, peer composition, branch restore, and the
  requires-cascade live in the library. `pi-lean-search` migrated from
  portal's old `setSearchSlot` callback to a self-managed `search.web`
  toolset that mirrors `portal.web` via `TOOLSET_EVENTS`. Both portal and
  search declare `pi-tool-masking` as a peerDependency; the package has no
  runtime transitive deps. The masking seam is clean — no logic is
  duplicated across the boundary.
- Refactor and documentation cleanup: deduplicated `setSearchStatus`, shared a
  `formatBytes` helper, simplified the bot-detection result shape, and removed
  unused exports across `core/shared`. No behavior change.
- **Dropped the lazy guide-content cache** — `getGuideContent()` now always
  reads user guides from disk (cheap, and removes a stale-cache footgun where
  a freshly `web-learn`ed guide wouldn't appear until invalidation).
  `invalidateGuideContent()` is removed; `web-learn` no longer calls it.
  `_setGuideContentForTest` now layers test overrides on top of the real
  builtin+user guides instead of replacing a cached map, and the guide tests
  mock `node:fs.existsSync` for the web-guides dir so on-disk user guides
  can't leak into the suite.

### Fixed

- **Status-bar glyph now syncs after `/tree` navigation** — the `browser`
  status-bar slot was stale after navigating the conversation tree:
  `browser-toggle`'s `session_tree` handler restored the toggle state and
  active-tool set from the branch, but nothing repainted the glyph, so the
  display could show `● idle` while the browser tools were actually
  disabled (or vice versa). `index.ts` now calls `updateFooterStatus` on
  `session_tree`, mirroring the existing `session_start` repaint. The fix
  is isolated to portal and ships independently of the in-flight host
  work.

- **`_wait_for_navigation_settle` hardened against late-arriving
  navigations** — the blind 400ms sleep in the no-navigation branch is
  replaced with a 50ms polling loop, so a `setTimeout`-delayed redirect
  that fires late under CI load is still captured instead of racing past
  the settle window. The method became an instance method reading two new
  opt-in class attrs: `_settle_budget_ms` (default `400`) and
  `_url_stability_settle` (default `False`), both unchanged for shipped
  `chromium-py`/`firefox-py`. Camoufox overrides to `2000`/`True` — its
  patched Juggler fires `framenavigated` and updates `page.url` with
  higher latency than a standard Playwright browser, so it waits for the
  URL to hold stable for 150ms (or the wider budget) before declaring
  no-nav. Fixes the `clicks a link with delayed navigation` flake and the
  four downstream cookie-persistence failures.

## [0.2.4] - 2026-07-20

### Fixed

- **`/web off` no longer re-enables other extensions' disabled tools** —
  `applyBrowserState(false)` rebuilt the active set from
  `pi.getAllTools()` (every registered tool) and filtered out only portal's
  own tools, silently re-activating any tool a peer extension or toggle had
  removed from the active set. The bug was latent as long as portal was the
  only thing disabling tools; any co-installed extension managing its own
  tool visibility would have its state clobbered by a subsequent `/web off`.
  The disable path now subtracts from `pi.getActiveTools()` (the
  currently-active set), matching the existing `applyLearnState` pattern,
  so peer toggles compose correctly. The symmetric enable path was already
  safe.

## [0.2.3] - 2026-07-15

### Added

- **`web-search` guidelines document bang syntax, engine restriction, and site operators** —
  `promptGuidelines` now advertises SearXNG bangs (`!wp`, `!images`, `!map`, `:<lang>`),
  the `engines` param for upstream restriction, and `site:`/`inurl:`/`intitle:`/`filetype:`
  operators (engine-dependent). All three features already worked; only visibility was missing.

### Fixed

- **`web-fetch` handles parallel calls without clobbering temp files** —
  `trackFetchFile` no longer eagerly deletes prior spill files for the same
  taskId on each new spill. Parallel fetches (e.g. two large pages fetched
  with the same default taskId) now both keep their temp files, fixing a
  data-loss bug where the agent would read a returned `filePath` only to
  find it already deleted. Adds a regression test.

## [0.2.2] - 2026-07-15

### Added

- **`web-search` surfaces SearXNG instant answers** — calculator, unit
  convert, `random uuid`, hashes, DuckDuckGo definitions, translations, and
  weather answers now render above the result list (in boxed blocks) instead
  of being silently dropped. Answers show even when there are zero web
  results, so an answerer-driven query like `avg 1 2 3` returns the answer
  rather than "No results found". The `SearXNGResponse.answers` type was
  corrected from `string[]` to a discriminated union on `template`. The TUI
  status line gains a `💡 N answer(s)` badge, `details` carries
  `answers`/`answerCount`, and `promptGuidelines` notes answerer-friendly
  query forms.

### Fixed

- **Agent-facing strings** — corrected inaccuracies in runtime messaging the
  agent sees when interacting with the browser:
- **`browser.maxStorageStateSize` is now wired** — the setting was documented
  and referenced in a runtime warning but never read; it's now parsed in
  `plugin-config.ts` and threaded through both `_persistState` paths.

## [0.2.1] - 2026-07-14

### Fixed

- **Camoufox link** — corrected the upstream Camoufox URL in the root and
  portal READMEs and the contributed docs.

## [0.2.0] - 2026-07-14

### Stealth backends (user-managed)

- **User-installed stealth backends** — patched/fingerprint-managed browser
  binaries (e.g. Camoufox) can now be registered as plugins. They live under
  `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/`, are never shipped in
  the npm tarball, and are never auto-downloaded — you write/audit the bridge,
  create the venv, fetch the binary, and register it in `settings.json`.
- **Camoufox reference template** — a tested `bridge.py` under
  `packages/pi-lean-portal/contributed/camoufox-py/`, plus
  `contributed/README.md` (install flow) and `contributed/CHOOSING.md` (when
  to reach for a stealth backend at all).
- **Quirks schema** — `PlaywrightBridge` subclasses declare engine quirks
  (`_fingerprint_managed_context`, `_skip_default_viewport`,
  `_scroll_via_wheel`, `_eval_prefix`) that the router and tools respect.
- **`probeUserBackend` helper** — discovers and validates user-managed Python
  backends for contract and parity testing.
- Multi-root plugin discovery, `browser.init` RPC, and `PYTHONPATH` injection
  for user backends (see `packages/pi-lean-portal/AGENTS.md`).

### MiniWoB++ evaluation harness

- **`bench/miniwob/`** — a `plugin.evaluate`-driven MiniWoB++ episode
  lifecycle with a Node `@e`-ref action layer, replacing the prior
  BrowserGym-based approach. Public API: `runMiniwobTask` and
  `registerMiniwobSuite` (lets user-owned parity files register custom
  backends without editing shipped code).
- **Per-backend suites** — chromium, firefox, chromium-py, firefox-py, plus
  adapter-smoke and a user-backends discovery suite (130 tasks × backend,
  auto-skips when prerequisites are absent).
- **Decision record** — `docs/decisions/miniwob-and-host-setup.md`
  documents the BrowserGym removal and host/MiniWoB setup rationale.

### Shared data & Python bridge

- **Shared JSON data tables** — bot-detection and accessibility tables moved
  to `core/shared/browser-data.json`, consumed by both Node
  (`browser-data.ts`) and Python (`browser_data.py`).
- **Python bridge refactor** — `playwright_base.py` rewrite with the stealth
  quirks schema; new `patch_playwright.py`; consolidated and expanded pytest
  suite (`test_py_bridges`, `test_playwright_base_quirks`,
  `test_browser_data`, `conftest`) — 243 pure-logic tests, needs only
  `pytest>=9.0`.

### Search

- **Pagination** — `web-search` now paginates results.

### Tools

- **Strategy visibility** — `browser-navigate`'s `strategy` parameter
  description is patched at registration with the actually configured plugin
  names (and any disabled ones), so the agent doesn't second-guess which
  strategies exist.

### CI & testing

- **GitHub Actions pipeline** (`.github/workflows/ci.yml`) — three jobs:
  `structural` (fast, no browser), `miniwob` (cross-engine browser tests), and
  an opt-in `contributed` job (Camoufox user-backends validation, manual
  trigger only).
- **New npm scripts** — `test:ci` (structural + contributed contract tests),
  `test:py-bridge` (Python bridge unit tests), `setup:miniwob`,
  `test:miniwob`.
- **Test infrastructure** — shared `persistence-suite`,
  `create-py-backend-harness`, `load-plugin-config-from-file`, and
  `probe-user-backend` helpers; an auto-discovery `run-contributed-suites`
  runner; expanded plugin-loading, registry, config, and session-manager
  tests.

## [0.1.0] - 2026-06-22

### Initial release — the web-tools suite

First public release of the pi-lean-dimension monorepo — three Pi extension
packages for web browsing and search.

- **`pi-lean-portal`** — Interactive browser, owns `/web` command (recommended).
- **`pi-lean-search`** — SearXNG search tool, wires into portal's `/web` toggle.
- **`pi-lean-dimension`** — Umbrella meta-package that bundles both.

### Features

- **13 tools**: `browser-navigate`, `browser-snapshot`, `browser-click`,
  `browser-type`, `browser-scroll`, `browser-back`, `browser-press`,
  `browser-console`, `browser-inspect`, `web-fetch`, `web-guide`, `web-learn`,
  `web-search`.
- **2 commands**: `/web on|off|learn|cookies|profile|status` and
  `/searxng-status`.
- **Playwright install UX:** `.npmrc` suppresses browser downloads during
  `npm install`. On first `browser-navigate` with no browsers installed, a
  clear notification prints `npx playwright install chromium firefox`.
- **Status bar:** Two independent glyphs (`browser`, `search`) show toggle
  state and SearXNG health.
- **Graceful degradation:** `web-search` registers even without SearXNG
  configured; on first unconfigured call it returns a setup message instead
  of failing silently or throwing.
- **Persistent profiles:** Session and named profiles for cookies/localStorage
  across conversations and subagents.
- **Navigation guides:** Four built-in pattern guides (bot-detection,
  cookie-consent, pagination, search) plus user-authored site guides via
  `web-learn`.
- **Lockstep versioning:** All three packages share v0.1.0.
