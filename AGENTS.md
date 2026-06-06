# AGENTS.md — pi-browser

> Guide for AI coding agents working on this repository.

## What This Project Is

pi-browser is a browser automation extension for the `@earendil-works/pi-coding-agent`. It gives AI agents the ability to browse the web through a two-tier escalation system (Playwright Chromium → stealth Firefox) plus a separate stateless `web-fetch` tool for fast content retrieval. The extension registers 11 tools (10 interactive browser tools + 1 stateless fetch tool) and 1 status command with the pi agent runtime.

## Repository Layout

```
pi-browser/
├── index.ts                    # Tool surface: 11 tools, /browser-status command, extension entry
├── package.json                # deps: playwright, node-html-parser, turndown, vitest (dev)
├── tsconfig.json               # strict mode, noEmit (compiled externally by host)
├── plan.md                     # Architecture analysis & phased refactor plan
├── STATE.md                    # Implementation tracking for fetch decoupling
├── vitest.config.ts            # Vitest configuration
│
├── __tests__/
│   ├── helpers/
│   │   └── test-server.ts      # HTTP test server helper for deterministic fixtures
│   ├── fetch-backend.test.ts   # 24 tests: webFetch(), JS detection, bot detection, content capping
│   └── url-safety.test.ts      # 46 tests: SSRF, schemes, secrets, malformed URLs
│
├── backend/
│   ├── router.ts               # Central dispatch: auto-escalation + per-operation routing
│   │                           # (interactive backends only — chromium/stealth)
│   ├── fetch-backend.ts        # Stateless HTTP fetch → Markdown (decoupled, used by web-fetch tool)
│   ├── playwright-backend.ts   # Level 2: Playwright Chromium automation
│   ├── stealth-backend.ts      # Level 3: JSON-RPC → Python subprocess (Invisible Playwright)
│   └── stealth_bridge.py       # Python side of the stealth JSON-RPC bridge
│
└── utils/
    ├── accessibility-tree.ts   # Parse Playwright ariaSnapshot → @e1/@e2 refs + element map
    ├── bot-detection.ts        # Cloudflare/CAPTCHA heuristic signals (shared by fetch & browser)
    ├── session-manager.ts      # Session lifecycle (create/update/remove per taskId)
    ├── url-safety.ts           # SSRF prevention, secret detection, scheme validation
    └── cdp-supervisor.ts       # Chrome DevTools Protocol: dialog auto-dismiss + console capture
```

## Key Concepts

### Two-Tier Auto-Escalation (Interactive Backends)

When `strategy="auto"` (the default), navigation follows this escalation path:

1. **Chromium** — Full Playwright Chromium session. Runs JS, takes accessibility-tree snapshots.
2. **Stealth** — Invisible Playwright (Firefox) via Python subprocess. Anti-bot evasion.

Escalation triggers:
- Chromium → Stealth: when bot detection signals are found (Cloudflare, CAPTCHAs)

Each tier can also be requested explicitly via the `strategy` parameter.

### Stateless Fetch (Separate Tool)

For quick content retrieval without interaction, use the **`web-fetch`** tool instead. It performs a plain HTTP fetch, converts HTML to Markdown, and returns the content inline. It does NOT create a browser session, has no `@e` refs, and is not part of the escalation chain. The agent decides which tool to use based on whether it needs to interact with the page.

| Aspect | `web-fetch` | `browser-navigate` |
|--------|-------------|--------------------|
| **Output** | Markdown text | Accessibility tree with `@e` refs |
| **State** | Stateless (one-shot) | Stateful session |
| **Interactivity** | None | click, type, scroll, press |
| **Speed** | Fast (HTTP only) | Slower (browser launch) |

### Session Model

- **One shared Chromium Browser** process, per-task `BrowserContext` + `Page`
- **Per-task Python subprocess** for stealth (complete process isolation)
- Sessions are created on first navigate, auto-recover from crashes, cleaned up on shutdown
- `lastNav` tracking survives session removal — enables `browser-snapshot` to auto-create a session

### @e References

All element interaction uses **role-based locators** via Playwright's `getByRole()`. The accessibility tree parser assigns `@e1`, `@e2`, etc. references to interactive elements. Agents use these refs to click, type, and interact. No XPath or CSS selectors are exposed.

### Auto-Snapshots

Every interaction tool (click, type, scroll, press, goBack) returns an automatic snapshot of the resulting page state. The calling agent doesn't need a separate `browser-snapshot` call to see what changed.

## Tool Surface (index.ts)

All tools follow the same pattern: parse params → call router or backend → wrap result + render.

| Tool | Purpose |
|------|---------|
| `web-fetch` | Stateless HTTP fetch → Markdown (fast, no JS, no session) |
| `browser-navigate` | Open URL with strategy selection and auto-escalation |
| `browser-snapshot` | Refresh accessibility tree, get fresh @e refs |
| `browser-click` | Click element by @e ref |
| `browser-type` | Type text into element by @e ref |
| `browser-scroll` | Scroll page up/down |
| `browser-screenshot` | Capture JPEG screenshot (data URI) |
| `browser-get-images` | Extract all `<img>` tags from page |
| `browser-back` | Navigate back in history |
| `browser-press` | Press a keyboard key |
| `browser-console` | Evaluate JS or read captured console output |

## Architecture & Data Flow

```
Agent calls web-fetch("https://example.com/page")
  │
  ▼ index.ts execute handler
  │
  ▼ fetch-backend.ts webFetch() — direct call, no router, no session
  │   ├─ URL safety validation
  │   ├─ HTTP fetch → HTML → Markdown conversion
  │   ├─ JS-shell detection
  │   ├─ Bot-detection heuristics
  │   └─ Content capping (inline + temp file spill for large pages)
  │
  ▲ returns WebFetchResult {content, title, needsJavaScript?, botDetected?, ...}

---

Agent calls browser-click("@e5")
  │
  ▼ index.ts execute handler
  │
  ▼ router.click(taskId, "@e5")
  │   ├─ requireInteractiveSession() — find or create session
  │   ├─ refBasedInteractionOrSnapshot() — skip if stale refs from auto-escalation
  │   └─ dispatch to chromium or stealth backend
  │       ├─ getElementCache(taskId).get("e5") → buildLocator(page, node)
  │       ├─ locator.waitFor({state:"visible"}) → locator.click()
  │       └─ auto-snapshot after interaction
  │
  ▲ router returns {success, snapshot?, elementCount?}
  │
  ▲ index.ts wraps in tool response + auto-attaches fresh snapshot
```

## Coding Conventions

- **TypeScript strict mode** with `noEmit` — the host compiles, not this project
- **No tests exist yet** — this is a known gap; be careful with refactors
- **Compact truncation everywhere**: snapshots capped ~2500 chars inline, fetch content ~4000 chars with temp file fallback for >5KB
- **Security-first URL handling**: always route through `url-safety.ts` for validation before navigation
- **Role-based locators only**: never introduce XPath or CSS selector-based interaction; always use `getByRole()`
- **Backend results are not unified**: chromium and stealth return different result types; the router normalizes them. See plan.md Phase 1 for the intended `BrowserPlugin` interface
- **Decoupled fetch**: `webFetch()` in `fetch-backend.ts` is self-contained (URL safety → fetch → JS detection → bot detection → content capping). No router involvement, no sessions.

## Known Technical Debt

1. **No backend abstraction** — The router uses hand-written if/else dispatch across 13 operations. Adding a new backend means touching every dispatcher. The `BrowserPlugin` interface in plan.md Phase 1 is the intended fix.
2. **Router is the bottleneck** — ~764 lines of procedural if/else. Each new operation adds ~40 lines.
3. **Element cache inconsistency** — Chromium stores full `AriaCachedNode`; stealth stores simplified `{role, name, level}`. The stealth parser manually extracts level from props strings.
4. **Console capture only on Chromium** — Stealth backend has stubs for `getConsoleMessages`/`clearConsole`. No CDP equivalent exists for Firefox.
5. **Full-page screenshots broken on stealth** — Parameter is accepted but not supported.
6. **Hard-coded Python path** — Stealth bridge expects `/opt/ipw-pyenv/bin/python`.
7. **✅ Fetch decoupled into separate `web-fetch` tool** — Fetch is no longer part of the router. It is a standalone tool with its own `webFetch()` entry point, URL safety, JS detection, bot detection, and content capping.
8. **Partial test infrastructure** — 70 tests cover URL safety (46) and fetch-backend (24). No tests yet for the interactive browser backends (playwright-backend, stealth-backend, router).

## Refactor Roadmap (from plan.md)

| Phase | Goal | Key Change | Status |
|-------|------|------------|--------|
| 1a | ✅ **Fetch decoupled into `web-fetch` tool** | Separate stateless HTTP tool, router simplified, no fetch in escalation chain | **DONE** |
| 1b | Extract `BrowserPlugin` interface | Unified result types, typed plugin registry, remove if/else dispatch | Pending |
| 2 | Restructure shared utilities | Move to `core/shared/`, add deprecated re-exports in `utils/` | Pending |
| 3 | Add quirks interface | Backend-specific capability differences (e.g., no full-page screenshot on stealth) | Pending |
| 4 | Community readiness | Full test harness, contribution guide | Pending |

**Fetch decoupling is done** — Phase 1a completed June 2026. The rest of Phase 1 (BrowserPlugin interface extraction) can proceed independently now that the fetch contradiction is resolved.

## Reading Order for New Contributors

1. `index.ts` — understand the 11 tools and how they call the router or fetch-backend directly
2. `backend/router.ts` — understand dispatch and escalation (start with `navigate()`)
3. `backend/fetch-backend.ts` — understand the decoupled `webFetch()` pipeline
4. `utils/accessibility-tree.ts` — understand how @e refs are generated and how locators are built
5. `plan.md` — understand the intended architecture and refactor rationale

## Important Files to Tread Lightly Around

- **`backend/router.ts`** — The most complex file; changes here affect all interactive backends. Always read the full dispatcher for an operation before modifying it.
- **`backend/fetch-backend.ts`** — The decoupled fetch backend. Changes here affect the `web-fetch` tool only.
- **`index.ts`** — Tool definitions for all 11 tools plus `webFetchTool`. Adding a new tool requires understanding both the interactive (router→backend) and stateless (fetch-backend) patterns.
- **`utils/accessibility-tree.ts`** — Both backends depend on the parser and `buildLocator()`. Changes here can break element interaction across the board.
- **`backend/stealth_bridge.py`** — The Python bridge runs in a subprocess with limited error recovery. Test manually after any changes.

## Security Considerations

- All URLs must pass through `url-safety.ts` validation (blocks localhost, private IPs, dangerous schemes)
- Secret detection runs on both raw and percent-decoded URLs
- Bot detection is intentionally soft — it warns and escalates but never silently swaps results
- JS dialogs are auto-dismissed to prevent agent blocking
