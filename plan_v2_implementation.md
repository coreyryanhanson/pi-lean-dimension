# pi-browser — Plugin Architecture v2: Implementation Strategy

> Date: 2026-06-08
> Status: **Active** — supplements `plan_v2.md` with phased implementation decisions
> Supersedes: Phase numbering in `plan_v2.md` §9

---

## 1. Guiding Principle: One Working Backend at All Times

The core constraint that shaped this strategy:

> **At every commit boundary, at least one interactive backend must be fully functional.**

This means we do NOT try to port both `playwright-backend.ts` and `stealth-backend.ts` simultaneously. Instead, we establish the plugin infrastructure with Chromium as the sole working backend, then layer Python backends on top.

### What we deliberately sacrifice (temporarily)

- **The stealth backend goes offline** during Phase A. It is not ported until Phase C.
- **No auto-escalation** — the router stops trying to fall back to stealth on bot detection.
- **The `strategy` parameter** will only accept `"auto"` and `"chromium"` until Phase C.

This is acceptable because:
1. `web-fetch` continues to work throughout (stateless, untouched).
2. Chromium continues to work throughout (the dominant backend).
3. The stealth backend's dependency (`invisible_playwright`) may not even be installed on most systems.
4. Git revert is always available if something breaks.

---

## 2. Key Design Decision: Python Adapter Validated with Chromium-Py

**Problem**: The `PythonPluginAdapter` + JSON-RPC bridge is the novel, untested infrastructure in this refactor. The only existing Python backend (`invisible_playwright`) may not be installed or maintained.

**Decision**: Validate the Python adapter using a **test-only Chromium-Py backend** — a Python bridge that drives Chromium via Playwright's Python API (`pip install playwright`).

### Why Chromium-Py instead of invisible_playwright

| Aspect | Chromium-Py | invisible_playwright |
|--------|------------|---------------------|
| **Availability** | `pip install playwright` — one-liner | Requires specific Python venv + binary |
| **Reliability** | Playwright Python is well-maintained | `invisible_playwright` has had outages |
| **Validation scope** | Tests adapter infrastructure end-to-end | Same, but with an unreliable dependency |
| **Overhead** | Subprocess around same browser | Subprocess around Firefox |
| **Production use** | **None** — development/validation only | Real stealth backend |

### How Chromium-Py works

1. Python bridge imports `playwright` (pip package)
2. `create_browser_session()` launches `chromium.launch()` via Playwright's sync API
3. All 13 operations use standard Playwright Python calls (click, fill, etc.)
4. JSON-RPC protocol is identical to what camoufox/invisible-playwright would use
5. The TypeScript `PythonPluginAdapter` doesn't know or care what browser Python is driving

### Chromium-Py is NOT a production backend

Running Chromium through a Python subprocess when Node already has it natively is pointless overhead. Chromium-Py exists to:

- Prove the `PythonPluginAdapter` works (spawn, JSON-RPC, crash recovery, element cache)
- Prove the `pi_browser_bridge` shared library works (transport, lifecycle, command routing)
- Provide a target for the plugin contract test harness without special hardware/software
- Be removed or moved to `__tests__/` once real stealth backends exist

**Registry flag**: Chromium-Py should be registered with `enabled: false` by default. It is only enabled explicitly for testing:

```jsonc
{
  "browser": {
    "plugins": [
      { "name": "chromium", "dir": "chromium" },
      { "name": "chromium-py", "dir": "chromium-py", "enabled": false }
    ]
  }
}
```

### What this enables

Once Chromium-Py validates the adapter, adding a real stealth backend is just:

1. Write a ~30-50 line `bridge.py` that imports `pi_browser_bridge` and overrides `create_browser_session()`
2. Add a config entry in `settings.json`
3. Run the contract test harness against it

The TypeScript adapter code, registry, router, and shared core are **already proven**. No leap of faith.

---

## 3. Restructured Phases

These phases replace `plan_v2.md` §9. References to `plan_v2.md` section numbers are noted where relevant.

### Phase A — Foundation (Chromium-only, no stealth)

**Goal**: Replace the if/else router with plugin registry dispatch. Chromium works exactly as before. Stealth is offline. `web-fetch` untouched.

| Step | What | Key Files | Risk |
|------|------|-----------|------|
| A1 | Extract `BrowserPlugin` interface + unified result types | `core/plugin-api.ts` | Low — new file, no existing code changed |
| A2 | Build `PluginRegistry` with typed registration + validation + default selection | `core/plugin-registry.ts` | Low — new file |
| A3 | Build plugin config loader (reads `browser.plugins`, validates, auto-detects type) | `core/plugin-config.ts` | Low — new file, no consumers yet |
| A4 | Port `playwright-backend.ts` → `ChromiumPlugin` class implementing `BrowserPlugin` | `backends/chromium/index.ts` | **Medium** — this is the working backend; must not break |
| A5 | Simplify router → registry-based dispatch (remove if/else, escalation, session transitions) | `core/router.ts` | **High** — highest-risk change; see §11.3 of plan_v2.md |
| A6 | Widen `BackendLevel` → `pluginName: string` in session manager | `core/shared/session-manager.ts` | Medium — touches session tracking |
| A7 | Remove `processHandle` from `BrowserSession` | `core/shared/session-manager.ts` | Low — dead code removal |
| A8 | Move shared utilities to `core/shared/` (with re-exports from `utils/`) | `core/shared/*.ts`, `utils/*.ts` | Low — re-exports preserve existing imports |
| A9 | Make `browser-navigate` strategy parameter dynamic (populated from registry) | `index.ts` | Medium — changes tool schema |
| A10 | Update `/browser-status` command for dynamic plugin list | `index.ts` | Low |
| A11 | Update `browser-toggle.ts` status bar for arbitrary plugin names | `browser-toggle.ts` | Low |
| A12 | Build `MockPlugin` fixture + plugin selection/dispatch tests | `__tests__/plugin-registry.test.ts` | Low — new test file |

**Validation gate**: After Phase A, these must pass:
- `npm test` (existing 132 tests + new registry tests)
- Manual: `browser-navigate https://example.com` works via Chromium
- Manual: `web-fetch https://example.com` still works
- Manual: `/browser-status` shows only chromium plugin

**What's intentionally broken after Phase A**:
- `strategy="stealth"` returns an error ("Plugin 'stealth' is not registered")
- `/browser-status` no longer checks for `/opt/ipw-pyenv/bin/python`
- Auto-escalation on bot detection is gone (agent gets `botDetected` warning, must retry manually)

### Phase B — Python Adapter Validation (Chromium-Py)

**Goal**: Prove the `PythonPluginAdapter` + JSON-RPC bridge + shared Python library work end-to-end, using Chromium-Py as the validation target.

| Step | What | Key Files | Risk |
|------|------|-----------|------|
| B1 | Build shared Python bridge library (`pi_browser_bridge` package) | `backends/python-base/pi_browser_bridge/` | Medium — new code, but well-understood pattern from `stealth_bridge.py` |
| B2 | Build `PythonPluginAdapter` (TypeScript side) | `backends/python-adapter.ts` | **High** — novel infrastructure; crash recovery, JSON-RPC dispatch, element cache |
| B3 | Create Chromium-Py backend: Python bridge driving Chromium via Playwright | `backends/chromium-py/bridge.py` | Low — straightforward Playwright Python usage |
| B4 | Wire Chromium-Py into registry (disabled by default) | Config entry + auto-detection | Low |
| B5 | Build plugin contract test harness | `__tests__/plugin-contract.test.ts` | Medium — reusable test suite |
| B6 | Test Chromium-Py against contract harness | `__tests__/chromium-py.test.ts` | Low — validates B1–B3 |
| B7 | Python adapter production hardening (crash recovery, heartbeat, error messages) | `backends/python-adapter.ts` | Medium — robustness |

**Validation gate** (✅ verified June 2026):
- ✅ All Phase A tests still pass (233 baseline → 386 after Phase B)
- ✅ Chromium-Py passes the plugin contract test harness (60 behavioral tests in `__tests__/chromium-py.test.ts`)
- ✅ Manual: `browser-navigate https://example.com strategy=chromium-py` works (after enabling in config)
- ✅ Python adapter survives bridge process crash (auto-restart via heartbeat miss detection + `_killProcess` + `ensureRunning` lazy restart)
- ✅ Element cache (`@e` refs) is consistent between Chromium and Chromium-Py (shared two-pass dialog priority, occurrence tracking, identical role sets)

### Phase C — Production Stealth Backends

**Goal**: Port the stealth backend and add Camoufox as real stealth plugins. Each is a thin bridge script on top of the proven Python adapter.

| Step | What | Key Files | Risk |
|------|------|-----------|------|
| C1 | Port `stealth_bridge.py` → use `pi_browser_bridge` base | `backends/stealth/bridge.py` | Medium — refactoring existing code |
| C2 | Port `stealth-backend.ts` → use `PythonPluginAdapter` | Remove `stealth-backend.ts`; stealth becomes config entry | Low — adapter is proven from Phase B |
| C3 | Create Camoufox backend | `backends/camoufox/bridge.py` | Low — thin wrapper |
| C4 | Contract-test both against the plugin test harness | `__tests__/stealth.test.ts`, `__tests__/camoufox.test.ts` | Low |
| C5 | Update tool descriptions and `/browser-status` for stealth levels | `index.ts` | Low |
| C6 | Document setup guides for each stealth backend | `backends/stealth/README.md`, `backends/camoufox/README.md` | Low |
| C7 | Remove Chromium-Py from production config (or move to dev-only) | Config default | Low |

**Validation gate**: After Phase C:
- All existing functionality restored (Chromium + stealth)
- New: Camoufox as an additional stealth option
- `strategy` parameter shows all registered plugins with stealth levels
- `/browser-status` shows all backends with stealth levels

### Phase D — Cleanup & Community Readiness

**Goal**: Polish for external contributors.

| Step | What | Key Files | Risk |
|------|------|-----------|------|
| D1 | Add deprecated re-exports in `utils/` (with `console.warn`) | `utils/*.ts` | Low |
| D2 | Write contribution guide | `backends/community/README.md` | Low |
| D3 | Document the `getImages`→`evaluate` dependency in plugin author guide | Docs | Low |
| D4 | Extract contract test harness to standalone import (optional) | `__tests__/plugin-contract.ts` | Low |
| D5 | Remove Chromium-Py backend entirely (if no longer needed for testing) | `backends/chromium-py/` | Low |

---

## 4. Risk Mitigation for Phase A (Highest-Risk Phase)

Phase A step A5 (router rewrite) is the single highest-risk change. Mitigations:

### 4.1 Incremental router migration

Don't rewrite the router in one shot. Instead:

1. **Add the registry alongside the existing if/else** — both code paths exist temporarily
2. **Add a feature flag** — `browser.useRegistryDispatch: boolean` in settings, default `false`
3. **When the flag is `true`**, the router uses `registry.get(session.level).method()` instead of if/else
4. **When the flag is `false`**, existing behavior is preserved
5. **Once the registry path passes all tests**, flip the default and remove the if/else path

This lets us validate the new dispatch without ever breaking the old one. The flag can be removed after one release cycle.

### 4.2 Router test strategy

The router currently has **zero tests** (noted in `AGENTS.md` § "Known Technical Debt"). Before rewriting it:

1. **Write characterization tests** against the current router behavior (using `MockPlugin` fixtures, not real browsers)
2. These tests capture: session creation, `lastNav` auto-recovery, `refBasedInteractionOrSnapshot` stale-ref handling, `compactSnapshot` truncation, error paths
3. **Then rewrite** — the characterization tests serve as a regression safety net

### 4.3 What to preserve from the current router

The router reduction is ~25–30% (per plan_v2.md §11.3). What survives:

- `requireInteractiveSession()` — auto-creates sessions from `lastNav`
- `refBasedInteractionOrSnapshot()` — stale-ref detection (simplified: no session-transition case)
- `compactSnapshot()` / `compactInteractionResult()` — truncation
- URL safety validation before dispatch
- Session management (`createSession`, `updateSession`, `setLastNav`, `removeSession`)
- Error normalization (catch throws → `{success: false, error}`)

What's eliminated:

- `escalateToStealthIfAuto()` — no auto-escalation
- All `if (session.level === "chromium") / if (session.level === "stealth")` branches — replaced by `registry.get(pluginName).method()`
- `takeSnapshotAfterEscalation()` — no session transitions
- `wasAutoEscalated` flag and all its consumers
- Session level changes mid-lifetime (e.g., `updateSession(taskId, { level: "stealth" })`)

---

## 5. File Structure After Phase A

```
pi-browser/
├── index.ts                    # Tool surface (updated: dynamic strategy param)
├── browser-toggle.ts           # Updated: arbitrary plugin names
│
├── core/
│   ├── plugin-api.ts           # BrowserPlugin interface + result types (NEW)
│   ├── plugin-registry.ts     # Typed registry (NEW)
│   ├── plugin-config.ts       # Config loader from settings.json (NEW)
│   ├── router.ts              # Simplified registry-based dispatch (REWRITTEN)
│   └── shared/
│       ├── accessibility-tree.ts  # Moved from utils/
│       ├── bot-detection.ts       # Moved from utils/
│       ├── session-manager.ts     # Moved from utils/, BackendLevel→string
│       ├── url-safety.ts          # Moved from utils/
│       └── cdp-supervisor.ts      # Moved from utils/
│
├── backends/
│   ├── chromium/
│   │   └── index.ts            # ChromiumPlugin class (PORTED from playwright-backend.ts)
│   └── (stealth/, chromium-py/, camoufox/ arrive in later phases)
│
├── fetch/
│   └── fetch-backend.ts       # Moved from backend/ (unchanged)
│
├── utils/                     # Deprecated re-exports from core/shared/
│   ├── accessibility-tree.ts
│   ├── bot-detection.ts
│   ├── session-manager.ts
│   ├── url-safety.ts
│   └── cdp-supervisor.ts
│
├── __tests__/
│   ├── helpers/
│   │   └── test-server.ts
│   ├── browser-toggle.test.ts
│   ├── fetch-backend.test.ts
│   ├── url-safety.test.ts
│   └── plugin-registry.test.ts    # NEW: MockPlugin + dispatch tests
│
├── backend/                   # LEGACY — removed after Phase A is validated
│   ├── router.ts              # Replaced by core/router.ts
│   ├── playwright-backend.ts  # Replaced by backends/chromium/index.ts
│   ├── stealth-backend.ts     # Removed (revived in Phase C via PythonPluginAdapter)
│   ├── stealth_bridge.py      # Removed (revived in Phase C via pi_browser_bridge)
│   └── fetch-backend.ts       # Moved to fetch/fetch-backend.ts
│
├── plan.md                    # Original plan (superseded)
├── plan_v2.md                 # Architecture specification
└── plan_v2_implementation.md  # This document
```

### File moves during Phase A

| Current Location | New Location | Notes |
|---|---|---|
| `backend/router.ts` | `core/router.ts` | Rewritten, not moved |
| `backend/playwright-backend.ts` | `backends/chromium/index.ts` | Ported to class |
| `backend/fetch-backend.ts` | `fetch/fetch-backend.ts` | Moved as-is |
| `backend/stealth-backend.ts` | *(removed)* | Revived in Phase C |
| `backend/stealth_bridge.py` | *(removed)* | Revived in Phase C |
| `utils/accessibility-tree.ts` | `core/shared/accessibility-tree.ts` | Moved, re-export added |
| `utils/bot-detection.ts` | `core/shared/bot-detection.ts` | Moved, re-export added |
| `utils/session-manager.ts` | `core/shared/session-manager.ts` | Moved, re-export added, BackendLevel→string |
| `utils/url-safety.ts` | `core/shared/url-safety.ts` | Moved, re-export added |
| `utils/cdp-supervisor.ts` | `core/shared/cdp-supervisor.ts` | Moved, re-export added |

### Legacy cleanup

After Phase A is validated (all tests pass, Chromium works, manual QA done):

1. Delete `backend/router.ts`, `backend/playwright-backend.ts`, `backend/stealth-backend.ts`, `backend/stealth_bridge.py`
2. Delete `backend/` directory entirely
3. Remove `utils/` re-exports (replace all imports with `core/shared/` paths)
4. Delete `utils/` directory

This cleanup can be a separate commit for easy bisection.

---

## 6. Detailed Step A4: Porting playwright-backend.ts → ChromiumPlugin

This is the most critical step in Phase A because it converts the working backend from a module with free functions to a class implementing `BrowserPlugin`. If this breaks, the extension is dead.

### Approach: Parallel existence

1. Create `backends/chromium/index.ts` with a `ChromiumPlugin` class
2. The class implements `BrowserPlugin` — wraps the existing logic
3. **Keep `backend/playwright-backend.ts` untouched initially**
4. Register `ChromiumPlugin` in the registry
5. Switch router to use registry dispatch
6. **Then** delete `playwright-backend.ts`

### What changes

- Free functions (`navigate()`, `click()`, etc.) become class methods
- The shared `Browser` instance management moves into `init()` / `cleanupAll()`
- Element cache (`getElementCache()`) stays internal to the class
- Result types change from `PlaywrightNavigateResult` etc. to the unified `NavigateResult` etc. from `plugin-api.ts`

### What stays the same

- All Playwright API calls (chromium launch, page creation, getByRole, etc.)
- CDP supervisor integration (dialog handlers, console capture)
- `parseSnapshot()` / `buildLocator()` usage from shared core
- Session-per-task model (BrowserContext per taskId)

---

## 7. Detailed Step A5: Router Rewrite

### Current router structure (~764 lines)

| Section | Lines | Survives Phase A? |
|---------|-------|--------------------|
| Imports + constants | ~30 | ✅ (updated paths) |
| `requireInteractiveSession()` | ~45 | ✅ (simplified: no escalation) |
| `takeSnapshotAfterEscalation()` | ~25 | ❌ Eliminated |
| Type definitions | ~40 | ✅ (moved to plugin-api.ts) |
| `escalateToStealthIfAuto()` | ~35 | ❌ Eliminated |
| `navigate()` | ~110 | ✅ (rewritten: registry dispatch) |
| `compactSnapshot()` | ~55 | ✅ (stays in router) |
| `refBasedInteractionOrSnapshot()` | ~25 | ✅ (simplified: no escalation case) |
| `compactInteractionResult()` | ~8 | ✅ |
| 8 operation dispatchers (click, type, scroll, screenshot, goBack, press, getImages, console/eval) | ~300 | ✅ (each ~35→~10 lines with registry) |
| `getConsoleMessages()`, `clearConsole()`, `evaluate()` | ~60 | ✅ (simplified) |

**Estimated new router size**: ~450–500 lines (down from 764, a ~35% reduction — more than the 25-30% estimate because we're also eliminating `takeSnapshotAfterEscalation` and the `wasAutoEscalated` flow).

### New dispatch pattern

**Before** (every operation):
```typescript
if (sr.session.level === "chromium")
    return compactInteractionResult(await playwrightBackend.click(tid, ref));
if (sr.session.level === "stealth")
    return compactInteractionResult(await stealthBackend.click(tid, ref));
return { success: false, error: "Unknown session level" };
```

**After**:
```typescript
const plugin = registry.get(sr.session.pluginName);
if (!plugin)
    return { success: false, error: `Plugin '${sr.session.pluginName}' not registered` };
return compactInteractionResult(await plugin.click(tid, ref));
```

### Session management changes

- `BackendLevel` → `pluginName: string` in `BrowserSession`
- `sessionManager.createSession(taskId, "chromium")` → `sessionManager.createSession(taskId, "chromium")` (same call, string type)
- `levelToSymbol()` → registry-driven lookup (plugin name → display symbol)
- `wasAutoEscalated` → eliminated (no escalation)
- Session `pluginName` is set once at creation, never changes

---

## 8. Feature Flag for Router Migration (Optional Safety Net)

If we want extra safety during Phase A step A5, we can add a temporary feature flag:

```jsonc
// settings.json
{
  "browser": {
    "useRegistryDispatch": false  // default: old if/else router
  }
}
```

When `false`: router uses the existing `playwright-backend` + `stealth-backend` imports directly.
When `true`: router uses `registry.get(pluginName).method()`.

This adds ~20 lines of conditional code but gives us a zero-risk rollback path that doesn't require `git revert`. Remove the flag after one release cycle.

**Recommendation**: Use the flag if we're shipping to users during Phase A. Skip it if this is all behind a dev branch (git revert is sufficient).

---

## 9. Test Strategy Summary

| Phase | New Tests | Total Test Count (est.) |
|-------|-----------|------------------------|
| **A** | `plugin-registry.test.ts` (~30 tests: registration, default selection, validation, dispatch) | ~162 |
| **B** | `plugin-contract.test.ts` (~15 tests: contract harness), `chromium-py.test.ts` (~10 tests: adapter-specific) | ~187 |
| **C** | `stealth.test.ts` (~10), `camoufox.test.ts` (~10) | ~207 |
| **D** | Deprecation warning tests | ~210 |

### MockPlugin fixture (Phase A)

A lightweight `BrowserPlugin` implementation for unit testing the registry and router:

```typescript
class MockPlugin implements BrowserPlugin {
    name = "mock";
    capabilities = { /* all true */ };
    callLog: string[] = [];

    async navigate(url: string, taskId: string, timeoutMs: number) {
        this.callLog.push(`navigate:${url}`);
        return { success: true, url, title: "Mock Page", content: "- mock\n", elementCount: 1 };
    }
    // ... all 13 operations + lifecycle hooks
}
```

Used to test:
- Registry registration and validation
- Default plugin selection
- Strategy parameter resolution ("auto" → first enabled)
- Session creation with correct plugin binding
- Error path: plugin not found
- Error path: plugin throws → router normalizes to `{success: false, error}`

### Plugin contract test harness (Phase B)

A reusable test suite that runs all 13 operations against a real browser via a local test server:

```typescript
function runContractTests(createPlugin: () => BrowserPlugin) {
    describe("BrowserPlugin contract", () => {
        // navigate returns @e refs
        // click/type return InteractionResult with auto-snapshot
        // screenshot returns valid data URI
        // ... all 13 operations
    });
}
```

---

## 10. Dependency on plan_v2.md

This document is a **companion** to `plan_v2.md`, not a replacement. The relationship:

| Concern | Where it's defined |
|---------|-------------------|
| Architecture, interfaces, config schema, capabilities, plugin selection semantics | **plan_v2.md** |
| Phased implementation order, risk mitigation, test strategy, file moves | **This document** |
| Codebase audit findings, design decisions | **plan_v2.md §11** |
| Step-by-step execution with validation gates | **This document §3** |

When implementing, read `plan_v2.md` for the "what" and "why", then this document for the "when" and "how".

---

*End of document.*
