# MiniWoB Driver: Eliminate the Cross-Process Browser Attach

**Status:** Executed (2026-07-07, commit `1ab7af0`).
**Branch:** `refactor/seperate-host-module`
**See also:** [`branch-outcome.md`](./branch-outcome.md) for the branch-level summary.

## Decision

Run the MiniWoB episode lifecycle (setup / validate / read utterance) through `plugin.evaluate(taskId, jsExpr)` on the plugin's own page. Remove the driver's browser connection entirely, and delete the now-orphaned cross-process attach framework in the portal.

The driver's entire job was ~10 lines of JavaScript execution on a page the plugin already owned. `BrowserPlugin` already exposed both primitives the driver needed — `navigate(url, taskId, timeoutMs)` and `evaluate(taskId, expression)` — so a second page-owner stitched to the first via attach plumbing was solving a problem that didn't exist.

## What was deleted

**Source (~614 lines, no portal consumer):**

- `core/shared/cdp-endpoint.ts` — the `ss -tlnp` CDP port scan.
- `plugin-api.ts` — the `getAttachEndpoint?()` method and `AttachEndpoint` union (`BrowserPlugin` drops 19 → 18 required methods).
- `backends/chromium/index.ts` — the `onBrowserLaunched` → `resolveCdpEndpoint` override and `--remote-debugging-port=0`/`--remote-debugging-address` launch args.
- `backends/firefox/index.ts` — `launchServer`, `_wsEndpoint`, `getAttachEndpoint`, `_reconnectBrowser`.
- `backends/playwright-base/playwright-plugin.ts` — the reconnect machinery and `BrowserServer` import.
- `backends/python-adapter.ts` — `_cdpEndpoint` / `_wsEndpoint` / discovery / `getAttachEndpoint`.
- `backends/firefox-py/bridge.py` — the dead `launch_server` path (Python Playwright has no `launch_server`).

**Structural tests (~950 lines):** `__tests__/cdp-endpoint.test.ts` and `__tests__/playwright-reconnect.test.ts` deleted outright; the `describeCdpEndpoint` / `describeWsEndpoint` blocks removed from `__tests__/python-adapter.test.ts`. `plugin-contract.test.ts` was unaffected (it never touched `getAttachEndpoint`).

**Driver + harness plumbing:** `miniwob-driver.py`, the `BridgeClient` subprocess class, and the `pythonPath` / `driverPythonPath` options removed from the host harness and exported types (a breaking change to `pi-lean-host`'s public surface; the package is independently versioned research tooling, and a compile error is a clearer signal than a silently-ignored option).

## What replaced it

- **`adapter/miniwob-episode.ts`** — TypeScript constants `SETUP_JS`, `VALIDATE_JS`, `READY_PROBE_JS`, `UTTERANCE_JS`, `REMOVE_DISPLAY_JS`. The `REMOVE_DISPLAY_JS` block was copied verbatim from BrowserGym (ServiceNow, Apache-2.0); no changes were made. The episode-setup protocol paraphrases BrowserGym's `base.py`. Attribution is recorded in the file header.
- **`adapter/miniwob-adapter.ts`** — `runMiniwobTask()` now drives the lifecycle directly: navigate → `REMOVE_DISPLAY_JS` → `SETUP_JS` → poll `READY_PROBE_JS` → `UTTERANCE_JS` → solver runs → poll `VALIDATE_JS`. `plugin.cleanup(taskId)` stays in a `finally`. Error propagation checks `EvaluateResult.success` / `.error` for every `evaluate` call.

`onBrowserLaunched()` is retained as a default-no-op post-launch hook for third-party subclasses; no portal backend overrides it.

## Why the attach was wrong (short version)

The driver was built as a *second* page-owner stitched to the plugin's via attach plumbing, copied from BrowserGym's shape. But in this architecture **the plugin owns the page**, not the task. The attach was fragile by construction: Playwright Firefox (Juggler) gives each `connect(ws)` client its own isolated contexts (no page sharing, unlike chromium CDP); the Python backends had no working `launch_server` and no CDP endpoint without a `CDP_PORT` env gate; and the `ss` port scan raced under parallel suite execution. The Node/Python Playwright versions also had to match exactly or firefox ws attach rejected with `428 Precondition Required`. The full failure forensics were recorded in the original proposal review and are no longer relevant — the code is gone.

## What was sacrificed (deliberate scope reduction)

- **The "plugin-owns-browser, external client attaches" capability (Mode A).** An external CDP/ws client can no longer ask the portal for its browser's attach descriptor. There was never a portal consumer — it was built solely for MiniWoB. **Reversal note:** if an unshipped consumer is identified later (out-of-process observer, screenshot tool, third-party CDP rider on the portal's browser), reintroduce it against that real consumer rather than reviving the orphaned framework.
- **Cross-process-attach testing.** The harness no longer verifies a separately-spawned Playwright client can attach to a running portal browser. Never a portal feature; if it becomes one, it needs its own suite.

Nothing about portal backend features, profiles, cookie/storage-state persistence, the accessibility-tree snapshot, bot detection, `web-fetch`, or the `/web` toggle changed. All four backends remain drivable; `firefox-py` becomes runnable for the first time and `chromium-py` runs without `CDP_PORT`.

## Expected outcome — confirmed

`npm run test:ci` stays green (23 files / 689 tests) because the structural tests for the deleted framework were removed in the same change. The MiniWoB suites go green across all four backends without serializing suite files, without version-pinning Python Playwright to Node's, and without a CDP port scan. The 112 skips remain for the same reasons as before (no goal-aware solver / no coordinate tool).
