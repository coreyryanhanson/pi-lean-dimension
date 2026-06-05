# Step 1 — Test Infrastructure Setup ✅ COMPLETE

> Part of Phase A: Fetch Decoupling (FETCH_DECOUPLING_PLAN.md)
> **Status**: Complete — all 46 tests pass (Vitest)
> **Date**: 2026-06-05

## What Was Done

### Chose Vitest over `node:test`

The original plan recommended the built-in `node:test` to keep things minimal with zero new dependencies. However, for ~50+ tests covering fetch-backend logic (content capping, JS detection, bot detection, redirect handling, etc.), Vitest provides significant advantages:

- **Parameterized tests** — collapse repetitive cases into single parametrized definitions via data-driven loops
- **Mocking** (`vi.mock`) — stub `http.request`, `fs.writeFileSync`, and anything else declaratively, without rewriting modules
- **Assertion messages** — shows both values with color diffs on failure
- **Watch mode** — re-runs only affected tests on file changes

The url-safety tests were written directly in Vitest (not migrated from `node:test` after the fact). They use typed tuple arrays as data-driven test sources, collapsing repetitive cases.

### 1. Installed `@types/node` dev dependency

The project's `tsconfig.json` had `"types": []` (empty), meaning no node type definitions were available. The test infrastructure needs Node.js built-in module types (`node:http`, `node:test`, `node:assert/strict`).

**Changes:**
- Ran `npm i -D @types/node`
- Updated `tsconfig.json`: changed `"types": []` → `"types": ["node", "vitest/globals"]`

Adding `"vitest/globals"` to the types array gives the LSP type definitions for `describe`, `it`, `test`, `expect`, etc. when used as globals (no explicit imports needed).

### 2. Removed `verbatimModuleSyntax` from tsconfig

The project had `"verbatimModuleSyntax": true`, which enforces that all imports/exports must match ES module semantics relative to the nearest `package.json`. Since no `"type": "module"` exists in package.json, `.ts` files were treated as CommonJS — but `import { ... } from "node:..."` syntax is ESM-only under strict CJS. This was blocking all test file compilation.

**Changes:**
- Removed `"verbatimModuleSyntax": true` from `tsconfig.json` (removed the whole line and its blank-line context)

This is a style/strictness setting, not a functional requirement. Removing it allows CJS-compatible ESM import syntax (which Node.js supports).

### 3. Added Vitest configuration + scripts

**Files created:**
- `vitest.config.ts` — minimal config enabling globals (`describe`/`it` without imports) and auto-discovery of `__tests__/**/*.test.ts`

**Changes to `package.json`:**
- Added `"vitest": "^4.1.8"` to devDependencies
- Added `"test": "vitest run"` and `"test:watch": "vitest"` scripts

### 4. Created test server helper: `__tests__/helpers/test-server.ts`

A minimal HTTP server for serving deterministic HTML fixtures in tests. Avoids depending on external websites.

**Key types and functions:**
- `TestServer` interface — exposes `server`, `url` (base URL string), and `stop()` method
- `startTestServer(handler)` — creates an HTTP server bound to `127.0.0.1` on a random port, resolves with the base URL

**Design notes:**
- Binds to `127.0.0.1` (not `0.0.0.0`) for security during tests
- Uses ephemeral port (`listen(0)`) to avoid conflicts
- The `stop()` promise correctly passes through `server.close()` errors

### 5. Created URL safety tests: `__tests__/url-safety.test.ts`

46 tests covering the existing `validateUrl()` function from `utils/url-safety.ts`. Written with Vitest's `expect()` assertions and data-driven loops using typed tuple arrays.

**Test categories:**

| Category | Count | What it validates |
|----------|-------|-------------------|
| Allowed URLs (param.) | 4 | Valid http/https with ports and query params pass through |
| Blocked hostnames, SSRF (param.) | 9 | 8 parametrized hostname blocks (localhost, 127.0.0.1, 0.0.0.0, [::1], AWS/GCP/Alibaba metadata) + 1 reason-string assertion |
| Private IP ranges (SSRF) | 4 | 10.x, 172.16-31.x, 192.168.x blocked; adjacent ranges allowed |
| Blocked schemes (param.) | 6 | 5 parametrized scheme blocks (file, ftp, data, javascript, vbscript) + 1 reason-string assertion |
| Secret patterns (param.) | 21 | 10 parametrized block checks + 10 reason-string checks (API keys, GitHub ghp_, Slack xoxb-, Stripe sk_live_, AWS AKIA, Google AIza) + 1 percent-encoded secret detection |
| Malformed URLs | 2 | "not a url" string, empty string — both return malformed error |

**Runner output:**
```
Test Files  1 passed (1)
     Tests  46 passed (46)
  Duration  2.5s
```

### Files Created/Modified

| File | Action | Lines |
|------|--------|-------|
| `__tests__/helpers/test-server.ts` | Created | ~28 |
| `__tests__/url-safety.test.ts` | Created | ~155 |
| `vitest.config.ts` | Created | ~7 |
| `package.json` | Modified | Added vitest + scripts |
| `tsconfig.json` | Modified | Added `"node"` and `"vitest/globals"` to types; removed `verbatimModuleSyntax` |

### Dependencies Added

- `@types/node` (devDependency)
- **`vitest ^4.1.8`** (devDependency) — test runner, assertion library, mocking, watch mode

---

## Why Vitest Over `node:test`

The project currently has zero tests. `node:test` is zero-config and built-in, but the 50+ tests planned for fetch-backend make the trade-off worthwhile:

- **Parameterization** — repetitive test cases (URLs to block, schemes to reject) collapse into single definitions instead of individual `it()` calls
- **Mocking** — testing timeouts, network failures, and temp-file logic requires stubbing Node.js built-ins; `vi.mock` is declarative while `node:test` has no mocking support
- **Watch mode** — fast iteration during fetch-backend implementation
- **Better assertion output** — colored diffs make test failures easier to diagnose

---

## Why These Other Choices

**Removed `verbatimModuleSyntax`.** This was blocking test file imports. The project can always add it back after converting to `"type": "module"` in package.json or using `.mts` files for ESM-only modules — but for now it was the path of least resistance.

**Test server binds to 127.0.0.1.** Not `0.0.0.0`. The test server is only accessible from localhost, matching the security model of the fetch backend itself (which also blocks private IPs).

---

## Next Step: Step 2 → Add `webFetch()` and Temp-File Logic to `fetch-backend.ts`

See [`STEP-2-PENDING.md`](./STEP-2-PENDING.md) for the plan.
