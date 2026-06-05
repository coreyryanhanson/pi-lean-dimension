# AGENTS.md — pi-browser

> Guide for AI coding agents working on this repository.

## What This Project Is

pi-browser is a browser automation extension for the `@earendil-works/pi-coding-agent`. It gives AI agents the ability to browse the web through a three-tier escalation system: plain HTTP fetch → Playwright Chromium → stealth Firefox (Invisible Playwright). The extension registers 10 browser tools and 1 status command with the pi agent runtime.

## Repository Layout

```
pi-browser/
├── index.ts                    # Tool surface: 10 tools, /browser-status command, extension entry
├── package.json                # deps: playwright, node-html-parser, turndown
├── tsconfig.json               # strict mode, noEmit (compiled externally by host)
├── plan.md                     # Architecture analysis & phased refactor plan
│
├── backend/
│   ├── router.ts               # Central dispatch: auto-escalation + per-operation routing
│   ├── fetch-backend.ts        # Level 1: stateless HTTP fetch → Markdown
│   ├── playwright-backend.ts   # Level 2: Playwright Chromium automation
│   ├── stealth-backend.ts      # Level 3: JSON-RPC → Python subprocess (Invisible Playwright)
│   └── stealth_bridge.py       # Python side of the stealth JSON-RPC bridge
│
└── utils/
    ├── accessibility-tree.ts   # Parse Playwright ariaSnapshot → @e1/@e2 refs + element map
    ├── bot-detection.ts        # Cloudflare/CAPTCHA heuristic signals
    ├── session-manager.ts      # Session lifecycle (create/update/remove per taskId)
    ├── url-safety.ts           # SSRF prevention, secret detection, scheme validation
    └── cdp-supervisor.ts       # Chrome DevTools Protocol: dialog auto-dismiss + console capture
```

## Key Concepts

### Three-Tier Auto-Escalation

When `strategy="auto"` (the default), navigation follows this escalation path:

1. **Fetch** — Plain HTTP, convert HTML to Markdown. Fast but can't run JS.
2. **Chromium** — Full Playwright Chromium session. Runs JS, takes snapshots.
3. **Stealth** — Invisible Playwright (Firefox) via Python subprocess. Anti-bot evasion.

Escalation triggers:
- Fetch → Chromium: when `needsJavaScript` is detected (empty SPA shells, noscript tags)
- Chromium → Stealth: when bot detection signals are found (Cloudflare, CAPTCHAs)

Each tier can also be requested explicitly via the `strategy` parameter.

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

All 10 tools follow the same pattern: parse params → call router → wrap result + render.

| Tool | Purpose |
|------|---------|
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

## Known Technical Debt

1. **No backend abstraction** — The router uses hand-written if/else dispatch across 13 operations. Adding a new backend means touching every dispatcher. The `BrowserPlugin` interface in plan.md Phase 1 is the intended fix.
2. **Router is the bottleneck** — ~767 lines of procedural if/else. Each new operation adds ~40 lines.
3. **Element cache inconsistency** — Chromium stores full `AriaCachedNode`; stealth stores simplified `{role, name, level}`. The stealth parser manually extracts level from props strings.
4. **Console capture only on Chromium** — Stealth backend has stubs for `getConsoleMessages`/`clearConsole`. No CDP equivalent exists for Firefox.
5. **Full-page screenshots broken on stealth** — Parameter is accepted but not supported.
6. **Hard-coded Python path** — Stealth bridge expects `/opt/ipw-pyenv/bin/python`.
7. **Fetch still inside browser-navigate** — plan.md calls fetch decoupling the "single most important architectural decision" but it hasn't been implemented yet.
8. **No test infrastructure** — 4000+ lines of complex browser logic with zero tests.

## Refactor Roadmap (from plan.md)

| Phase | Goal | Key Change |
|-------|------|------------|
| 1 | Extract `BrowserPlugin` interface | Unified result types, typed plugin registry, decouple fetch into separate `web-fetch` tool |
| 2 | Restructure shared utilities | Move to `core/shared/`, add deprecated re-exports in `utils/` |
| 3 | Add quirks interface | Backend-specific capability differences (e.g., no full-page screenshot on stealth) |
| 4 | Community readiness | Test harness, contribution guide |

**Do not implement phases out of order** — Phase 1 unblocks everything else.

## Reading Order for New Contributors

1. `index.ts` — understand the 10 tools and how they call the router
2. `backend/router.ts` — understand dispatch and escalation (start with `navigate()`)
3. `utils/accessibility-tree.ts` — understand how @e refs are generated and how locators are built
4. `plan.md` — understand the intended architecture and refactor rationale

## Important Files to Tread Lightly Around

- **`backend/router.ts`** — The most complex file; changes here affect all backends. Always read the full dispatcher for an operation before modifying it.
- **`utils/accessibility-tree.ts`** — Both backends depend on the parser and `buildLocator()`. Changes here can break element interaction across the board.
- **`backend/stealth_bridge.py`** — The Python bridge runs in a subprocess with limited error recovery. Test manually after any changes.

## Security Considerations

- All URLs must pass through `url-safety.ts` validation (blocks localhost, private IPs, dangerous schemes)
- Secret detection runs on both raw and percent-decoded URLs
- Bot detection is intentionally soft — it warns and escalates but never silently swaps results
- JS dialogs are auto-dismissed to prevent agent blocking
