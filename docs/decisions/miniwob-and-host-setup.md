# Decision: Host Package, MiniWoB Driver, and Why No BrowserGym

**Status:** Shipped. Consolidates the `refactor/seperate-host-module` branch
history (BrowserGym adoption → removal → cross-process attach → attach
elimination) into the takeaways that matter going forward.

## The setup we ended up with

- **The MiniWoB evaluation harness** lives at `bench/miniwob/` and evaluates
  `BrowserPlugin` backends against MiniWoB++ tasks. It is **not** part of
  the `pi-lean-dimension` umbrella meta-package (it lives outside `packages/`
  as a repo-level evaluation artifact). Portal framework internals stay
  covered by mocked unit tests in `pi-lean-portal`; behavioral evaluation
  lives under `bench/miniwob/`.
- **The MiniWoB episode lifecycle runs through `plugin.evaluate()`** on the
  plugin's own page. `adapter/miniwob-episode.ts` holds the JS constants
  (`SETUP_JS`, `VALIDATE_JS`, `READY_PROBE_JS`, `UTTERANCE_JS`,
  `REMOVE_DISPLAY_JS`); `adapter/miniwob-adapter.ts` drives
  navigate → removeDisplay → setup → poll ready → utterance → solver → poll
  validate, with `plugin.cleanup(taskId)` in a `finally`. Attribution:
  `REMOVE_DISPLAY_JS` was copied verbatim from BrowserGym (ServiceNow,
  Apache-2.0); the episode-setup protocol paraphrases BrowserGym's `base.py`.
  See the file header.
- **The invariant: the plugin owns the page and drives all actions; the
  harness only runs the episode lifecycle.** All four shipped backends
  (chromium, firefox, chromium-py, firefox-py) are drivable via
  `navigate` + `evaluate`. `firefox-py` is runnable for the first time;
  `chromium-py` runs without a `CDP_PORT` env var.
- **Public API:** `runMiniwobTask` and `registerMiniwobSuite` let user-owned
  parity tests register a custom `BrowserPlugin` without editing shipped
  code.
- **CI:** `structural` job (no browser, fast) + `miniwob` job (installs
  Chromium + Firefox + Python `playwright`, clones MiniWoB++ content, runs
  all 8 suite files under `bench/miniwob/suites/`). Per-backend suites
  auto-skip when prereqs are absent, so `npm test` / `npm run test:ci` stay
  green in bare CI.

## Why we dropped BrowserGym

BrowserGym was initially adopted as a dev-only `browsergym[miniwob]`
dependency for task/reward sourcing. Three structural problems killed it:

1. **Playwright version pin (`==1.44`).** BrowserGym pins Playwright at
   1.44, structurally incompatible with a browsing tool that must stay
   current for real web interaction.
2. **In-process design overhead.** The in-process design existed solely to
   engineer around BrowserGym's dependency footprint — complexity with no
   benefit to the core mission.
3. **WebArena is the wrong justification.** BrowserGym's real value
   (WebArena reward computation) requires a standalone Mode B bridge in its
   own venv — a separate future decision, unrelated to MiniWoB.

A ~50-line hand-rolled driver replaced it; the driver subprocess was later
eliminated entirely (see below). BrowserGym's value to us is now limited to
the protocol/JS we attributed in `miniwob-episode.ts`.

## Why we eliminated the cross-process attach

The first cut of the host kept BrowserGym's shape: a *second* page-owner
(the driver subprocess) stitched to the plugin's page via CDP/ws attach.
`BrowserPlugin` gained `getAttachEndpoint?()` / `connectOverCDP?()` and a
union of attach descriptors. This was fragile by construction, and the
driver's entire job was ~10 lines of JS on a page the plugin already owned.
`BrowserPlugin` already exposed both primitives needed (`navigate` and
`evaluate`), so a second page-owner was solving a problem that didn't exist.

### Pitfalls of the shared chromium/firefox Playwright instances

These are the failure modes that made the attach approach untenable, and
the things to keep in mind if anyone ever proposes reintroducing an
external client that attaches to the portal's running browser:

- **Firefox (Juggler) does not share pages across `connect(ws)` clients.**
  Each ws client gets its own isolated contexts. Unlike chromium CDP,
  there is no "ride along on the same page" — the second client is in its
  own world. This makes a Firefox attach-based driver a non-starter unless
  you restructure ownership.
- **Python Playwright has no `launch_server`.** The firefox-py `launch_server`
  path was dead code on arrival. The Python backends had no working ws
  endpoint, and chromium-py only exposed CDP if you set a `CDP_PORT` env
  var — a non-obvious gate that silently no-op'd otherwise.
- **Node and Python Playwright versions must match exactly** for Firefox ws
  attach, or the server rejects with `428 Precondition Required`. A
  browsing tool that must stay current cannot pin its Playwright to match
  a foreign Python venv.
- **The `ss -tlnp` CDP port scan races under parallel suite execution.**
  Multiple backends launching simultaneously produced flaky/unreliable
  endpoint discovery.
- **There was never a portal consumer.** The attach hooks
  (`getAttachEndpoint?` / `connectOverCDP?`, the `AttachEndpoint` union,
  the chromium `onBrowserLaunched` CDP-discovery override, the firefox
  `launchServer`/`_reconnectBrowser`/`_wsEndpoint` path, the python-adapter
  CDP/ws discovery) existed solely to serve MiniWoB. ~614 lines of source
  and ~950 lines of structural tests were deleted with no portal feature
  regressing.

### What was sacrificed

- **The "plugin-owns-browser, external client attaches" capability (Mode
  A).** An external CDP/ws client can no longer ask the portal for its
  browser's attach descriptor. **Reversal note:** if a real consumer is
  identified later (out-of-process observer, screenshot tool, third-party
  CDP rider), reintroduce attach against that consumer rather than reviving
  the orphaned framework — and design it around the Firefox/Python pitfalls
  above from day one.
- **Cross-process-attach testing.** The harness no longer verifies a
  separately-spawned Playwright client can attach to a running portal
  browser. Never a portal feature; if it becomes one, it needs its own
  suite.

`onBrowserLaunched()` was retained as a default-no-op post-launch hook for
third-party subclasses (no portal backend overrode it); it was later removed
as dead code when no third-party consumer materialised.

## What MiniWoB does not cover

Canvas/coordinate tasks, drag-and-drop, hover/slider/select (no tools), and
any framework/structural concern (router dispatch, plugin registry, config
loading, snapshot cache, etc.). Those remain covered by the portal
structural test suite.
