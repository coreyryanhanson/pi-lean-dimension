# Branch Outcome — `refactor/seperate-host-module`

**Status:** Shipped. `npm run test:ci` green (23 files / 689 tests). MiniWoB suites implemented; cross-engine green wherever browser prereqs are met.
**Scope note:** This branch pivoted several times (BrowserGym adoption → removal → cross-process attach → attach elimination). This document records only what it **actually delivers**. Pivot history lives in the sibling decision records.

## What this branch does

Three things, in dependency order:

1. **Splits the MiniWoB++ evaluation harness into its own package, `pi-lean-host`.**
   Behavioral browser evaluation moves out of `pi-lean-portal` into a separately-versioned research package that consumes the portal's `BrowserPlugin` interface as a peer. The portal keeps only structural/mocked tests. `pi-lean-host` is **not** part of the `pi-lean-dimension` umbrella meta-package — it is independently versioned research tooling.

2. **Drops BrowserGym as a runtime dependency.**
   BrowserGym pinned Playwright to `1.44`, structurally incompatible with a browsing tool that must stay current. Replaced with a hand-rolled MiniWoB driver. See [`browsergym-removal.md`](./browsergym-removal.md).

3. **Eliminates the cross-process browser attach.**
   The MiniWoB episode lifecycle (setup / validate / read utterance) now runs as `plugin.evaluate(taskId, jsExpr)` calls on the plugin's own page. The driver subprocess, the CDP/ws attach plumbing, and the `getAttachEndpoint()` interface method are deleted. See [`miniwob-driver-attach-elimination.md`](./miniwob-driver-attach-elimination.md).

## Net effect on the tree

- **New package:** `packages/pi-lean-host/` — adapter (`miniwob-adapter.ts`, `miniwob-episode.ts`), solvers (`parser.ts`, `trivial-solvers.ts`, `register-suite.ts`), 5 suite files, MiniWoB static server + setup script, public API (`runMiniwobTask`, `registerMiniwobSuite`).
- **Deleted from portal:** the cross-process attach framework — `core/shared/cdp-endpoint.ts`, the `AttachEndpoint` union + `getAttachEndpoint?()` method on `BrowserPlugin` (interface 19 → 18 required methods), the chromium `onBrowserLaunched` CDP-discovery override, the firefox `launchServer`/`_reconnectBrowser`/`_wsEndpoint` path, the python-adapter CDP/ws discovery, the firefox-py `launch_server` dead path, and the matching structural tests (`cdp-endpoint.test.ts`, `playwright-reconnect.test.ts`, two describe blocks in `python-adapter.test.ts`).
- **Deleted from host:** `miniwob-driver.py`, the `BridgeClient` subprocess class, and the `pythonPath`/`driverPythonPath` options from the harness and exported types.
- **Retained:** `onBrowserLaunched()` as a no-op post-launch hook for third-party subclasses (no portal backend overrides it).

## Capabilities the branch delivers

- **Cross-engine parity coverage.** All four shipped backends (chromium, firefox, chromium-py, firefox-py) are drivable by the harness via `navigate` + `evaluate`. `firefox-py` becomes runnable for the first time (the `launch_server` blocker is removed); `chromium-py` runs without a `CDP_PORT` env var.
- **User-pluggable backends.** `registerMiniwobSuite(backend, getBaseUrl)` lets user-owned parity tests register a custom `BrowserPlugin` (e.g. a stealth backend) without editing shipped code.
- **125-task MiniWoB++ suite per backend.** 13 trivial solvers run (3 confident asserting `reward > 0`, 10 best-effort pipeline smoke); 77 element tasks skip pending a goal-aware solver; 35 non-element tasks skip pending coordinate/drag/hover/select tools.
- **Two-job CI.** `structural` (no browser, fast) + `miniwob` (installs Chromium + Firefox + Python `playwright`, clones MiniWoB++ content, runs all 5 suite files). Per-backend suites auto-skip when their prereqs are absent, so `npm test` and `npm run test:ci` stay green in bare CI.

## What the harness continues to prove

The portal's real `@e`-ref action layer (`click` / `type` / `snapshot` / `scroll` / `press` / `goBack` / `navigate`) exercised against a live MiniWoB page across all four backends. The invariant — *the plugin owns the page and drives all actions; the harness only runs the episode lifecycle* — is strengthened: setup and validate are now `plugin.evaluate` calls, so the plugin is the sole owner of the page and all JS execution.

## What was retired (deliberate scope reduction)

- **The "plugin-owns-browser, external client attaches" capability (Mode A).** An external CDP/ws client can no longer ask the portal for its browser's attach descriptor. **There was never a portal consumer** — it was built solely for MiniWoB. If a future use case wants it (out-of-process observer, screenshot tool, third-party CDP rider), it must be reintroduced against a real consumer. See the elimination record for the reversal note.
- **Cross-process-attach testing.** The harness no longer verifies that a separately-spawned Playwright client can attach to a running portal browser. This was never a portal feature; if it becomes one, it needs its own suite.

## What MiniWoB does not cover

Canvas/coordinate tasks, drag-and-drop, hover/slider/select (no tools), and any framework/structural concern (router dispatch, plugin registry, config loading, snapshot cache, etc.). Those remain covered by the portal structural test suite.

## Decision trail

- [`browsergym-removal.md`](./browsergym-removal.md) — the BrowserGym Option C plan (considered, then rejected) and the decision to drop it for a hand-rolled driver.
- [`miniwob-driver-attach-elimination.md`](./miniwob-driver-attach-elimination.md) — delete the cross-process attach; run the episode via `plugin.evaluate`.
- [`miniwob-driver-attach-elimination.md`](./miniwob-driver-attach-elimination.md) — delete the cross-process attach; run the episode via `plugin.evaluate`.
