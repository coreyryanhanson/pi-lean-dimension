# AGENTS.md — pi-browser

> Compact instruction file for an agent working on this repo.

## What This Is

A pi extension that registers **14 tools + 2 commands** for web browsing. Architecture: plugin-based dispatch via `PluginRegistry` + typed `BrowserPlugin` interface + stateless `web-fetch` tool.

## Developer Commands

```bash
npm test              # vitest run — 493 tests across 15 files (all pass)
npx vitest run __tests__/router-dispatch.test.ts  # single test file
npm run test:watch    # vitest in watch mode
npx tsx scripts/dialog-gate.ts        # side-by-side backend comparison
npx tsx scripts/dialog-gate.ts --preset basic-close --repeat 20  # with preset
```

There is no build step (`noEmit: true` in tsconfig). The extension is loaded directly by pi from the source TypeScript files. No linter or formatter is configured.

## Directory Layout (compact)

```
pi-browser/
├── index.ts                  # Entry: registers 14 tools + 2 commands
├── browser-toggle.ts         # /web on|off|learn|status — three-state toggle
├── backends/                 # Plugin implementations
│   ├── chromium/index.ts     # Node/Playwright, reference ~1100 lines
│   ├── python-adapter.ts     # JSON-RPC bridge for subprocess plugins
│   └── chromium-py/bridge.py # Python bridge, disabled by default
├── core/                     # Framework: shared across all plugins
│   ├── plugin-api.ts         # BrowserPlugin interface, 13 result types
│   ├── plugin-registry.ts    # Registration, validation, strategy resolution
│   ├── plugin-config.ts      # Reads browser.plugins from settings.json
│   ├── router.ts             # Dispatch, session lifecycle, truncation, browser-inspect
│   ├── guides.ts             # Guide types, builtin guides, file loader, presence resolution
│   ├── fetch-backend.ts      # Stateless HTTP → Markdown (web-fetch only)
│   └── shared/               # session-manager, url-safety, bot-detection, cdp-supervisor, accessibility-tree, snapshot-cache, dom-extractor
├── guides/                  # User-authored guide files (gitignored)
├── scripts/                  # dialog-gate.ts, experiment reports
└── __tests__/                # 13 test files + helpers/
```

## Architecture

### Plugin system

All interactive backends implement `BrowserPlugin` (`core/plugin-api.ts`). 14 required operations:

```
navigate, snapshot, click, type, scroll, goBack, press,
screenshot, getImages, getConsoleMessages, clearConsole,
evaluate, getElementCache, cleanup  (+ lifecycle: init, cleanupAll)
```

Capabilities (`PluginCapabilities`) advertise quirks. The router checks them at dispatch time (e.g. `supportsFullPageScreenshot` for fallback, `supportsAbortSignal` to skip signal wiring, `supportsConsoleCapture` for message-capture gating).

Plugin loading: reads `browser.plugins` from `~/.pi/agent/settings.json` (global, merged with `.pi/settings.json` project-local). Each entry is `{name, dir, enabled, config}`. `dir` maps to `backends/<dir>/`; entry point is auto-detected (`index.ts` = Node plugin, `bridge.py` = Python plugin). If no plugins configure, a default ChromiumPlugin is created.

**Active plugins (config-driven):**
- **`chromium`** — Node/Playwright (~1100 lines), always enabled by default, reference implementation
- **`chromium-py`** — Python/Playwright (~950 lines bridge.py), disabled by default

### Router (`core/router.ts`)

All tool calls dispatch through the router. Key responsibilities:
- **Strategy resolution**: `PluginRegistry.resolveStrategy("auto")` → first enabled plugin; `"<name>"` → named plugin
- **Session lifecycle**: per-taskId sessions created on first navigate, cleaned up on shutdown
- **Compact truncation**: `< 2800 chars` raw, cut at ~2500; `> 8000 chars` preserve top ~2000
- **Bot-detection downgrade**: when `botDetected && elementCount < 5`, navigate fails hard (blocks are unreadable)
- **Bot-detected snapshots are NOT compacted** — full content passes through for human judgment
- **All interaction results have fingerprint appended**: `\nfingerprint:XXXXX` for DOM-change detection
- **Auto-recovery**: crashed sessions are detected and re-navigated to the last URL
- **Stale @e ref handling**: if a session was just auto-created, interaction tools return a fresh snapshot instead of performing the action

### Key Tools

| Tool | Use Case | State | Speed |
|------|----------|-------|-------|
| `web-fetch` | Static page → Markdown, no JS needed | Stateless | Fast |
| `browser-navigate` | Interactive page → accessibility tree with @e refs | Stateful session | Slower |
| `browser-inspect` | Element queries + text extraction with @e ref annotations | Stateful session | Fast (sync cache) |
| `web-guide` | Get navigation guidance for a site or pattern | Stateless | Instant |
| `web-learn` | Save or update navigation guidance for a site | Stateless | Instant |

`web-fetch` uses plain `fetch()` + `node-html-parser` + `turndown`. Returns ~4000 chars inline, spills to temp file when larger. `browser-navigate` uses Playwright Chromium, returns accessibility tree with @e1/@e2 refs.

### Registered tools (14 total)

web-fetch, browser-navigate, browser-snapshot, browser-click, browser-type, browser-scroll, browser-screenshot, browser-get-images, browser-back, browser-press, browser-console, browser-inspect, web-guide, web-learn

### Registered commands (2 total)

`/browser-status` — show backend health and active sessions
`/web on|off|learn|status` — /web on (browsing only), /web off (all disabled),
                                 /web learn (browsing + guide-saving via web-learn),
                                 /web (show current state)

### Guides (`core/guides.ts`)

Type definitions (`Guide`, `GuideTrigger`, `GuideCategory`, `GuideSource`,
`DomainEntry`, `GuidePresenceResult`), the `BUILTIN_GUIDES` record (4 pattern guides + 1 test-only site fixture),
`DOMAIN_MAP` for domain-to-guide resolution,
`loadUserGuides()`/`parseGuideFile()` for user-authored guides (YAML frontmatter
+ markdown body), `resolveGuidePresence()` for three-tier auto-presence
(auto-inject / auto-hint / on-demand), `dialogPresentInSnapshot()` for dialog
detection from accessibility tree text, `readGuidesConfig()` for
`browser.guides.autoInject` from settings.json, and `cleanupInjectedGuides()`
for per-task injection tracking cleanup.

### Guide Creation (web-learn tool)

Guides are saved or updated via the `web-learn` tool, invoked in response to
a user request (explicit or contextual). The tool creates a `.md` file with YAML
frontmatter in `guides/`, including a `domains` field that automatically triggers
domain hints on future navigations. Calling `web-learn` again on the same domain
updates the existing file (new content, new date).

The `/web learn` command must be active or the tool isn't in the active tool set.
Default is `/web on` (browsing only).

Toggle state is persisted via `pi.appendEntry("browser-toggle-state", ...)` per-session branch, surviving `/reload`, `/resume`, `/fork`.

## Testing

### Test files (16 files, 527 tests passing)

| File | Requires Chromium? |
|------|--------------------|
| router-dispatch.test.ts | No |
| browser-toggle.test.ts | No |
| plugin-registry.test.ts | No |
| plugin-contract.test.ts | No (structural) |
| python-adapter.test.ts | No |
| fetch-backend.test.ts | No |
| accessibility-tree.test.ts | No |
| url-safety.test.ts | No |
| plugin-loading.test.ts | No |
| snapshot-cache.test.ts | No |
| browser-inspect.test.ts | No |
| web-guides.test.ts | No |
| dialog-compaction.test.ts (archived) | No |
| occlusion-live.test.ts | Yes (auto-skip) |
| reddit-dialog.test.ts | Yes (auto-skip) |
| chromium-py.test.ts | Yes (auto-skip) |

Integration tests (`occlusion-live`, `reddit-dialog`, `chromium-py`) skip automatically when Playwright Chromium is unavailable. The archived dialog-compaction test lives under `core/archived/`.

### Shared test utilities (`__tests__/helpers/`)

- `plugin-contract.ts` — `runContractTests(name, factory, opts?)` validates any BrowserPlugin
- `mock-plugin.ts` — MockPlugin for structural contract validation
- `reddit-fixture.ts` — HTML fixtures for Reddit dialog occlusion scenarios (4 variants)
- `test-server.ts` — `startTestServer()` returns a local HTTP server for integration tests
- External test server: `occlusion-test-server.cjs` for local debugging

### Contract test harness

`runContractTests()` from `plugin-contract.ts` validates structural contracts (all 13 operations exist, result shapes) without a browser, and behavioral tests (`realBrowser: true`) with a live Chromium against the local test server.

## Known Constraints & Debt

- **Console capture only on Chromium** — Python adapter's `BridgeBase` has capture but `chromium-py` bridge doesn't call it yet
- **AbortSignal not supported on Python bridge** — `supportsAbortSignal: false`, router skips signal wiring
- **Sessions are per taskId** — tasks are stable pi session IDs mapped to `browser-NNN` keys via `_sessionKeys`/`_sessionCounter` in index.ts. Created on first navigate, cleaned up on session_shutdown
- **Role-based locators only**: never XPath/CSS — always `getByRole()` via `buildLocator()` with positional `.nth()` for duplicates. The `INTERACTIVE_ROLES` set defines which roles get @e refs
- **All URLs go through `url-safety.ts`** — blocks localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 169.254.169.254), dangerous schemes (file:, ftp:, data:, javascript:, vbscript:), and heuristically detects secrets in URLs
- **Screenshot**: JPEG 80% quality, viewport constrained to 1024px wide, returns data URI
- **Compact truncation everywhere**: snapshots ~2500 chars inline (with `\nfingerprint:XXXXX` suffix), fetch content ~4000 chars with temp file spill to `/tmp/pi-browser-fetch-*`
- **Truncation hint text** (Phase 3): The old `"(use full=true for complete tree)"` hint has been removed from compactSnapshot() and replaced with router-appended hints:
  - **Cached snapshot**: `📄 Full snapshot cached at {path}\n   read the cache file for the exact ARIA tree, or use browser-inspect for quick targeted element discovery`
  - **Not cached** (write failure, bot detected, or snapshot() tool): `(use browser-inspect role=... name=... to find specific elements, or use browser-snapshot full=true for the complete tree)`
  - The cache file is the authoritative source for exact `@e` refs; `browser-inspect` is a cheaper first attempt for targeted discovery.
- **Snapshot Disk Cache** (`core/shared/snapshot-cache.ts`): when compactSnapshot() truncates a page's accessibility tree, the full tree is written to `/tmp/pi-browser/snapshot-*.txt`. The agent can `read` this file with offset/limit to find elements past the truncation boundary. `@e` refs remain valid because the element cache is independent of what text the agent reads.
  - Only caches when truncation actually occurred (snapshot > 2800 chars)
  - Bot-detected snapshots are never cached
  - Keeps last 2 files per task
  - Cache notice is appended to truncated output with action guidance pointing to `browser-inspect`
  - When snapshot is truncated but not cached, a fallback hint is shown instead
  - All I/O is try-catched — graceful degradation to inline-only on failure
  - Cleaned up on session removal and shutdown
- **`browser_finetuning.md`** — occlusion/dialog/timing hardening strategy. Read before touching ChromiumPlugin click or snapshot logic
- **`plan_v2.md`** — full plugin-refactor architecture doc. Read before adding a new plugin type or changing the registry
- **`browser-inspect`** (`core/shared/dom-extractor.ts`): element + text extraction tool. Uses an inline `EXTRACTOR_SCRIPT` evaluated via `page.evaluate()` (bypasses CSP). Requires `getElementCache()` on the plugin. Staleness detection via `lastInteractionAt` vs `cachePopulatedAt`. Python parity is in-scope — bridge must include `elements` dict in responses for adapter-level cache to work.
  - **Text output truncation**: when `text=true` without an explicit `maxChars`, the output is truncated at ~2500 characters by default. Pass `maxChars=0` for full content. Truncated output appends `"\n… X more chars (use maxChars=0 for full content)"` so the agent knows how to retrieve the complete text.
  - **Keyword filtering**: the optional `query` parameter filters extracted content to only include elements whose text matches the given case-insensitive substring. Applied before correlation, so only matching elements get @e ref annotations. When no content matches, a notice is appended to the output. Also checks link `href` and image `src` fields.
- **`parentRef` on `AriaCachedNode`**: set by a depth-based parent stack in `parseSnapshot()`'s second pass. Enables `subtree=...` queries in `browser-inspect`. A `dialog`/`alertdialog` element becomes the parent of interior elements. Same-depth siblings share the same parent.
- **Guide content discipline**: guides should be ≤800 chars. No runtime enforcement — authoring discipline.
- **`dialogPresentInSnapshot` is a string scan**: checks for `role="dialog"` in the already-truncated snapshot. May miss dialogs below the truncation boundary. A proper `dialogDetected` field on `NavigateResult` is deferred.
- **Guide staleness**: pattern guides (bot-detection, cookie-consent, pagination, search) are kept generic and reviewed periodically. No builtin site guides are shipped — site guidance is entirely user-authored via `guides/*.md`. Guides carry `updated` date paired with `currentDate` in output for the agent to assess freshness.
- **Domain map is built dynamically from guide files**: the only static entry
  is the test-only fixture (`_internal-test.example`). Any guide in `guides/`
  with a `domains` frontmatter field automatically contributes domain hints.
  Caches invalidate on `web-learn` tool calls — no reload needed.
- **Learn mode toggle**: `/web learn` adds `web-learn` to the active tool set;
  `/web on` removes it. The agent never calls `web-learn` unprompted — it only
  saves or updates guides when the user asks or the context implies it.
  State is persisted per-session-branch. Internally stores two independent booleans.
  Legacy `/web on|off` branches restore correctly.
  Learn mode defaults to off on fresh sessions.
- **`BROWSER_DEBUG=1`** — enables structured `[browser]` log lines on stderr (navigate, snapshot, click, occlusion events). Only checks in ChromiumPlugin

## Debugging

```bash
BROWSER_DEBUG=1 npx vitest run __tests__/occlusion-live.test.ts
```

Set `BROWSER_DEBUG=1` for structured logging from ChromiumPlugin.

## TypeScript Quirks

- `noEmit: true` — source-only, no build step
- `exactOptionalPropertyTypes: true` — `undefined` in optional params triggers type errors; use `Type.Optional()` wrapper (from `@earendil-works/pi-ai`) for tool parameters
- `noUncheckedIndexedAccess: true` — all indexed accesses require null checks
- `module: "nodenext"` — imports need `.js` extensions in source files

## `backends/` vs `core/` Boundaries

- `backends/` — plugin-specific implementations (Node or Python)
- `core/` — framework: plugin API, registry, config loader, router, shared utilities
- `core/shared/` — utilities used by both framework and plugins
- Plugins import from `../../core/plugin-api.js` and `../../core/shared/*.js`
- The router imports from `../../core/plugin-api.js` and `../../core/shared/*.js`