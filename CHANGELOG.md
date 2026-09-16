# Changelog

## [Unreleased]

### Changed

- **`pi-lean-host` — org header on all tool-channel disambiguation menus** —
  when a domain is claimed by multiple guides sharing one `organization:`, the
  `api-learn` and `api-scaffold` menus now show the `(organization: X)` header
  like `api-guide`'s menu already did, giving the agent the same ownership
  signal when picking between sibling recipes. Shared menu/error rendering
  extracted to one helper (no other behavior change).

### Added

- **`pi-lean-host` — OAuth paste-prompt recovery** — Esc at the auth-code
  paste prompt no longer discards the flow. It now opens a recovery input:
  Enter repastes into the untouched pending flow, typing a corrected
  redirect URI restarts the authorization (fresh PKCE/state/authorize URL)
  with every wizard answer preserved, and Esc still aborts to the
  `--code` nudge. Fixes the dead end where a wrong redirect URI — never
  registered at the provider, so no code was ever issued — cost the whole
  wizard redo.

- **`pi-lean-portal` — `/web install` browser installer** — a
  user-triggered command that downloads the Node-backend browsers
  through the **bundled** Playwright CLI, so the revisions always match
  the Playwright version the backends actually run (the `npx` advice
  could resolve a different copy and install mismatched revisions). Bare
  `/web install` opens a TUI checklist — missing engines pre-checked,
  downloaded engines listed and toggleable — while
  `/web install chromium|firefox` installs directly. Detection is
  shell-aware: Chromium is verified via its
  `chromium_headless_shell-<rev>` directory and Playwright's
  `INSTALLATION_COMPLETE` marker rather than the full-browser path, so a
  full-chromium-only cache correctly reports "missing". Non-TUI contexts
  print the resolved manual command instead of hanging on a silent
  download. Playwright resolves lazily, so a corrupt install degrades to
  that manual command rather than breaking `/web`.

### Changed

- **`pi-lean-portal` — missing-browser hints now point at `/web install`** —
  the install hints in the Chromium and Firefox backends, the
  `browser-navigate` failure notify, and the abstract `installHint` JSDoc
  now read `Browser not installed. Run /web install to install it.`
  (the `not installed` substring is load-bearing — `browser-navigate`
  gates its notify on it). `/web status` gains a `Browsers:` line showing
  per-engine state with a `(run /web install)` hint when something is
  missing. READMEs shift from `npx playwright install` to `/web install`
  (one cautioned `npx` footnote stays for CI/non-TUI setups), and the
  command tables gain the `install` entry.

### Fixed

- **Request timeouts now bound the response body, not just the headers** —
  in `web-search` (`pi-lean-search`) and `web-fetch`'s `performFetch`
  (`pi-lean-portal`), the abort timer was disarmed as soon as `fetch()`
  resolved — i.e. when response **headers** arrived — so a server that
  sent headers and then stalled the body hung the body read with no
  deadline, far past the advertised `timeout` budget (only undici's
  internal ~300s idle limit stopped it). The timer now stays armed
  through the body read and is cleared in a `finally`. In `web-search`
  an abort raised during the body read previously surfaced in the
  JSON-parse catch and would have been mislabeled `parseError:
  "SearXNG may be misconfigured"`; both catches now route aborts through
  one shared handler that reports the timeout/cancel correctly. Portal's
  caller already labeled body-phase aborts as timeouts, so its fix is
  the timer coverage alone.

## [0.5.0] - 2026-09-11

### Added

- **`pi-lean-host` — declarative REST API client package** — a new
  workspace package giving the agent recipe-based access to REST APIs. A
  guide is one markdown file with YAML frontmatter (`guide.md`) declaring
  an API's host, endpoints, auth, pagination, and response shape; a fixed
  executor runs the declared operation so an API encoded once is reusable
  forever, not re-derived each session. Guides live at
  `~/.pi/agent/pi-lean-host/api-guides/<slug(shortName)>/` — only files you
  place there execute. Ships 7 tools (`api-guide`, `api-fetch`,
  `api-learn`, `api-probe`, `api-scaffold`, `api-store`, `oauth-mint`) and
  the `/api` command. GET-read only — no mutation helper. Declares
  `pi-lean-portal` as an **optional peer dependency** — host-only installs
  are valid.
- **`/api` toggle — independent peer of `/web`** — three states (`on`,
  `learn`, `off`); the authoring tools are gated behind `learn`; starts
  **on**. The two toggles compose freely (e.g. `/api on` + `/web off` =
  pure api-only context for batch structured-data pulls), each with its
  own status-bar glyph. Subcommands: `verify` (live-runs a guide's ops and
  stamps `verified` on success, strict threshold, `--force` for
  human-attested), `delete`, `oauth`, `bootstrap`, `secrets`, `helpers`,
  `status`. State persists via `pi-tool-masking`; actuating subcommands
  are refused while a focus mode is active. Persist keys:
  `toolset-state:pi-lean-dimension.api` / `.api-learn` (overridable via the
  `toolsetDefaults` settings block).
- **Authoring loop** — `api-learn` stages a working copy to
  `/tmp/pi-lean-host/` for template creation and fetched-recipe editing,
  then mirror-saves a staged directory back (deletion-safety gate refuses
  unconfirmed sibling wipes). `api-probe` fetches an exploratory path,
  summarizes the JSON shape, and emits a draft operation block — it
  suggests, never writes. `api-scaffold` bootstraps a starter
  `verify.json` (sentinel-filled) and/or `helper.ts` stub into the same
  staging dir. `/api verify` runs the ops against the live API.
- **Auth and secrets** — `auth.kind` is a `NoneAuth | StaticKeyAuth |
  OAuth2Auth` union with nested `SecretRef`s (`{ secret, prefix?,
  optional? }`). Secrets persist per-domain at
  `~/.pi/agent/pi-lean-host/secrets/<domain>.json` (mode `0600`),
  provisioned transcript-safely via `/api secrets` (names only, never
  values). Values are resolved and injected in code — they never enter
  agent context — and are scrubbed from error bodies and surfaced headers,
  with query-param secrets redacted on every surfaced URL. OAuth2 covers
  `client_credentials` (auto-mint/refresh) and a headless paste-based
  auth-code flow; `oauth-mint` is the human-in-the-loop mint tool and
  `api-store` a read-only view of both credential stores (metadata only).
- **Execution** — six pagination styles (`offset-limit`, `page`,
  `nextLink`, `cursor`, `resumptionToken`, `tokenBag`) with a
  `gatherAll` exhaustion walk under a per-op ceiling; op-level
  `errorPath` envelopes fail present-only-on-error 200 bodies; `helper.ts`
  files reshape params pre-call (`helper: true`) and a per-op built-in
  transform runs post-parse (`transform: true`) — distinct mechanisms, each
  under a load/call guard. The shared transport caches
  only on an explicit server freshness grant (`Cache-Control: max-age` or
  ETag/304 — never a fabricated TTL), and the SSRF guard blocks
  loopback/private/metadata targets on server-supplied pagination URLs.
  The guide schema is closed (unknown keys are parse errors) and
  `schemaVersion`-stamped; a truncated `api-fetch` result spills the full
  JSON to disk for the session.
- **Multi-recipe domains** — a domain may claim multiple guides;
  `api-guide` disambiguates and `api-fetch` resolves ops by name across
  all matches. Bundled `api-guides/` are repo-only test fixtures, not
  recipes to copy — the comprehensive recipe library lives in the
  separate `Caritas` repo.

### Changed

- **`pi-lean-portal` — `BrowserPlugin.getStorageState` removed from the
  plugin interface** — it had no production caller: profile persistence
  routes through the shared `persistSessionState()` helper, and the
  Python adapter talks to the `browser.getStorageState` RPC directly.
  Custom Node backends in `user-backends/` should drop the method from
  their implementation. Nothing else changes — cookies keep their own
  `getCookies`/`addCookies`/`clearCookies` methods.

- **`pi-lean-portal` — plugin validation hard-requires more operations** —
  `REQUIRED_OPERATIONS` (`core/plugin-registry.ts`) now also rejects a
  backend missing `getElementCache`, `getCookies`, `addCookies`,
  `clearCookies`, or `cleanupAll` at load time. Custom Node backends in
  `user-backends/` that previously registered while missing any of these
  must implement them.

- **`pi-lean-search` — unconfigured-SearXNG startup notice** — when
  `searxng.url` is unset, the `search` status bar slot stays hidden
  (existing behavior) but a one-time warning notify now fires on Pi
  process boot pointing at the `searxng.url` setting and
  `/searxng-status`. Skipped on `/new`, `/resume`, and `/fork` so it
  never repeats mid-session; users who deliberately don't run SearXNG
  see one boot-time message instead of a hidden slot with no
  explanation.

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

- **`pi-tool-masking` bumped to `^1.3.0`** — spawned `pi` children no
  longer enforce `toolsetDefaults` pins, including the
  `toolset-state:pi-lean-dimension.*` toggle keys, since a spawner that
  explicitly configures a child's tools shouldn't be overridden by global
  settings pins. Set `"piToolMasking": { "childPolicy": "settings" }` to
  restore enforcement in children (see the pi-tool-masking 1.3.0
  changelog for full semantics).

### Fixed

- **Settings readers honor `PI_CODING_AGENT_DIR`** — the global
  `settings.json` path in `pi-lean-search`'s `search-config.ts` and
  portal's shared `settings-reader.ts` was hardcoded to `~/.pi/agent`,
  while their own dependency (`pi-tool-masking`'s `settingsPath()`)
  honors `PI_CODING_AGENT_DIR`. A user with a relocated agent dir got
  toolset defaults read from the relocated file but `searxng.url` and
  `browser` config read from the stale `~/.pi/agent/settings.json` —
  silent misconfig, no warning. Both readers now resolve
  `$PI_CODING_AGENT_DIR/settings.json` with the `~/.pi/agent` fallback,
  matching the library. Portal-owned data directories (profiles,
  cookies, sessions) are deliberately unchanged.

- **`browser-inspect` `parentRef` chains were never built, so `subtree=`
  found nothing; ancestry now resolves for directly nested interactive
  elements** — both the TypeScript (`core/shared/accessibility-tree.ts`)
  and Python (`pi_browser_bridge/accessibility.py`) ARIA parsers treated the
  raw leading-space count of an `ariaSnapshot()` line as a nesting-level
  index. Playwright emits 2 spaces per level, so in the TypeScript parser
  `parentStack[depth - 1]` read an array hole and `parentRef` was never
  assigned for any nested element (`subtree=` ancestry silently found
  nothing), while the Python parser's append-based stack invented ancestry —
  siblings claimed each other as parents, so `subtree=` returned elements
  from outside the container. Both parsers now normalize depth to the
  nesting level (spaces ÷ 2), and the Python parent stack pads skipped
  levels (non-interactive containers create gaps) with `None`, matching the
  TS hole-filled array. Re-emitted snapshot indentation no longer doubles on
  nested elements, and sibling elements can no longer pass a `parentRef`
  chain check. Regression tests cover nested, sibling, and skip-level
  hierarchies on both runtimes.
- **`browser` status slot no longer flip-flops between renderers** —
  `updateFooterStatus` (`tools/utils.ts`) and `renderBrowserGlyph`
  (`browser-toggle.ts`) both wrote to the `browser` status slot from the
  same cached flags but emitted different strings (`● idle` vs
  `● PW: example.com [profile]`), so the display depended on which path
  ran last. The session-aware renderer is now the only one:
  `renderBrowserGlyph` is deleted, `syncCachedState` calls
  `updateFooterStatus` on toolset toggle/restore events, and the portal
  `AGENTS.md` status-bar section reflects the session-aware format.
- **Snapshot shutdown no longer deletes other sessions' temp files** —
  `removeAllSnapshotFiles()` performed a recursive delete of the shared
  temp dir (`/tmp/pi-lean-portal`), which also contained other running
  sessions' fetch spill files and screenshots, so one conversation's
  shutdown could break another's in-flight reads. It now removes only
  the snapshot files it tracks. Tracked-file cleanup (hash prefix,
  per-task tracking, best-effort removal) is consolidated into a shared
  `core/shared/temp-files.ts` used by both the snapshot cache and the
  fetch backend; stale orphan files from crashed sessions now live
  until normal `/tmp` cleanup instead of being swept at shutdown.
- **`browser-inspect` schema no longer promises unsupported `ref` +
  `text=true` subtree scoping** — the `ref` description claimed that
  combining it with `text=true` scopes the DOM walker to that element's
  subtree, but `text=true` always extracts the whole page (`params.ref`
  is only consumed on the element-query path). The description is
  corrected; scoping remains a possible future feature.

- **`/web profile` restore now picks the newest choice, not the oldest** —
  `restoreProfile()` in `browser-toggle.ts` returned on the **first**
  `portal-conversation-state` entry found in the session branch, but
  `getBranch()` walks chronologically root→leaf — so after switching
  profiles mid-conversation (e.g. `/web profile work` →
  `/web profile shopping`), a `/reload`, `/resume`, or branch switch via
  `/tree` silently restored the **first** profile chosen in the session
  instead of the most recent one. The loop now keeps walking and the last
  valid entry wins, matching pi's own session-persistence convention
  (last-writer-wins) and fixing restore on both `session_start` and
  `session_tree`. Covered by a new regression test feeding two
  chronological entries and asserting the newest wins.

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
