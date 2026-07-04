 Research: Simulated Websites for Agent Browser Integration Tests

 This is not an unrealistic goal at all — there's actually a thriving ecosystem of precisely what you're looking for, born from the AI agent benchmarking wave. Here's what I found:

 ────────────────────────────────────────────────────────────────────────────────

### Tier 1: Self-Hosted Realistic Web Environments (Highest Fidelity)

#### 1. REAL (agi-inc/REAL (<https://github.com/agi-inc/REAL>))

- What it is: Deterministic, high-fidelity replicas of 11 real-world apps — Amazon, Uber, Airbnb, Gmail, Google Calendar, DoorDash, United Airlines, OpenTable, LinkedIn, UpWork, Zillow
- 112 human-written tasks ("Buy a laptop", "Book a flight", "Compose an email")
- Programmatic state verification + LLM-guided evaluation for info retrieval
- Leaderboard at realevals.xyz (<https://www.realevals.xyz>)
- ⚠️ Only 7 stars — still very new (May 2025), AGI Inc. backed

#### 2. WebArena (web-arena-x/webarena (<https://github.com/web-arena-x/webarena>)) ⭐ Most mature

- 1.5k stars, Apache-2.0, paper from Stanford (NeurIPS 2023)
- Self-hostable Docker containers mimicking 4 categories:
  - Shopping site (admin panel included)
  - Social forum
  - Developer CMS (WordPress-like)
  - Collaborative whiteboard
- ~800 eval tasks via browser automation traces from human annotators
- Requires setting up your own instances with Docker — not trivial but documented
- Has a newer variant: WebArena-Infinity which auto-generates environments from app docs using Claude Code

#### 3. BrowserGym (ServiceNow/BrowserGym (<https://github.com/ServiceNow/BrowserGym>)) ⭐ Most comprehensive framework

- 1.3k stars, actively maintained (v0.14.3, Jan 2026)
- Gymnasium interface for web agent benchmarking — wraps ALL of the above
- Ships with 8 built-in benchmarks: MiniWoB++, WebArena, VisualWebArena, WorkArena, AssistantBench, WebLINX, OpenApps, TimeWarp
- Easy pip install browsergym + playwright install chromium
- You can create custom tasks by extending AbstractBrowserTask
- This is probably your best starting point

 ────────────────────────────────────────────────────────────────────────────────

### Tier 2: Synthetic but Sophisticated Task Libraries (Easiest to Use)

#### MiniWoB++ (miniwob.farama.org (<https://miniwob.farama.org/>)) — Part of BrowserGym

- 126 deterministic synthetic web tasks in a single-page app
- Categories and task types include:
  - Click: buttons, links, menus, tabs, dialogs, collapsibles, color matching, shape targeting, pie menus, scroll lists
  - Input: text entry (plain, dynamic, upper/lower case), passwords, dates, times
  - Drag & drop: boxes, circles, shapes, grid items, number sorting, 3D cubes
  - Form filling: checkboxes, radio buttons, option selectors
  - Search: finding nth word, ascending numbers, bisect angles, midpoints
  - Complex: email inbox navigation, copy-paste sequences

 These are deterministic (server-generated HTML/JS), lightweight (no Docker needed), and designed specifically to stress-test agent perception/action pipelines.

 ────────────────────────────────────────────────────────────────────────────────

### My Honest Assessment

 ┌──────────────────────────┬───────────────────┬──────────────────────────┬──────────────────────────────────┐
 │ Criteria                 │ REAL              │ WebArena                 │ BrowserGym + MiniWoB             │
 ├──────────────────────────┼───────────────────┼──────────────────────────┼──────────────────────────────────┤
 │ Deterministic?           │ ✅ Yes            │ ✅ Yes (self-hosted)     │ ✅ Yes (MiniWoB)                 │
 ├──────────────────────────┼───────────────────┼──────────────────────────┼──────────────────────────────────┤
 │ Sophistication           │ High (real apps)  │ Medium (mimicked apps)   │ Medium-Low (synthetic but broad) │
 ├──────────────────────────┼───────────────────┼──────────────────────────┼──────────────────────────────────┤
 │ Setup complexity         │ Low (pip install) │ High (Docker containers) │ Low (pip install)                │
 ├──────────────────────────┼───────────────────┼──────────────────────────┼──────────────────────────────────┤
 │ Challenge for your tools │ Excellent         │ Great                    │ Good starting point              │
 └──────────────────────────┴───────────────────┴──────────────────────────┴──────────────────────────────────┘

### What I Think About Your Goal

 It's a very realistic thing to look for — the entire AI agent community has been building exactly this. The tension you're sensing is real:

- Simple synthetic sites (MiniWoB) are deterministic and easy but may be too toy-like to challenge sophisticated browser tools
- Realistic cloned apps (REAL, WebArena) are challenging but require Docker infrastructure and more setup
- The gap in between — a single self-hosted site with realistic forms, AJAX-driven content, dynamic elements, multi-step flows — is less served

### Recommendation for Your Project (pi-lean-dimension)

 Given your architecture (Playwright backends, accessibility tree parsing, @e ref system, guides, bot detection), the BrowserGym + MiniWoB combo would give you:

 1. Immediate test infrastructure — 126 tasks with clear pass/fail criteria
 2. Coverage of edge cases — collapsibles, dialogs, tabbed UIs, dynamic content, drag-drop, multi-step forms
 3. A progression path — layer in WebArena later for deeper integration testing

 You could also consider building your own "challenging test suite" alongside MiniWoB — a self-hosted app with real-world patterns like infinite scroll, cookie consent modals, tab switching with state changes, and
 form validation errors. That's where the most value would be for specifically testing your browser plugin ecosystem.

 ────────────────────────────────────────────────────────────────────────────────

## MiniWoB Integration — Actual Findings

 Based on implementing MiniWoB++ tests for `pi-lean-portal` (see
 [`miniwob-integration-plan.md`](miniwob-integration-plan.md)).

### Spike Results (Step 0, July 2026)

 **PASS ✅** — All three representative tasks (`click-button`, `email-inbox`,
 `form-sequence`) rendered interactive elements with `@e` refs in the
 accessibility snapshot. Key discoveries:

- **No iframes.** All task content renders at top-level DOM inside `#area`.
   The iframe concern in the original research was unfounded for this
   MiniWoB++ commit (`7fd85d71`).
- **START overlay.** Every task has a `START` overlay (`<div id="sync-task-cover">`)
   that must be clicked (or monkeypatched via JS injection) before
   interactive content appears. Porting BrowserGym's `base.py` `setup()` JS
   injection is essential.
- **Viewport 1280×720.** The default Chromium viewport is large enough;
   BrowserGym uses 332×214×1.5 but coordinate tasks (already excluded) are
   the only ones sensitive to viewport.

### Coverage Ceiling: ~50% (not all 126 tasks are reachable)

 Cross-referencing the 125 tasks (`all.py` defines 125 classes, not 126)
 against our `BrowserPlugin` interface:

 | Requires | Count | Reachable | Notes |
 |----------|-------|-----------|-------|
 | `element` | 90 | ✅ | click, type, press, scroll, navigate, snapshot |
 | `coord` | 18 | ❌ | canvas rendering — no semantic elements |
 | `drag` | 12 | ❌ | no `drag` action on `BrowserPlugin` |
 | `hover` | 4 | ❌ | no `hover` tool |
 | `select` | 1 | ❌ | no `select` tool |

 **Realistic ceiling: ~50-60 tasks** (~72% of element tasks, ~50% of total).
 The "126 tasks" headline is misleading for any agent that only uses
 accessibility-tree `@e` refs without canvas or coordinate awareness.

### Current Implementation Status (as of Step 3)

- **125-task table ported** to `helpers/miniwob.ts` with requires classification.
- **`runMiniwobTask` driver** navigates, injects BrowserGym's setup JS,
   polls `WOB_DONE_GLOBAL`, returns `{reward, rawReward, done, reason, info,
   timedOut, setupFailed}`.
- **13 tasks have trivial solvers** (click the obvious button / type into
   the first textbox). 3 confident (assert reward > 0) + 10 best-effort
   (pipeline smoke).
- **77 element tasks** skipped — need goal-aware solvers (future work).
- **35 non-element tasks** skipped — missing tools.
- **4 shipped backends** supported: chromium (13/13 pass), firefox (13/13),
   chromium-py (auto-skip if Python lacks Chromium), firefox-py (13/13).
- **User-installed backends** (camoufox-py, invisible-py) are NOT hardcoded
   in shipped code — the reusable `registerMiniwobSuite()` machinery lets
   user-owned parity test files register custom backends.
- **Camoufox-py diagnostic:** Stealth Firefox destroys the execution context
   during the `removeDisplay()` setup injection block. A future injection
   path (non-`mw:`-prefixed eval, split injection) could unblock it.

### Architecture Decision: Port the Task Model, Not the Framework

 | Approach | Chosen? | Reason |
 |----------|---------|--------|
 | Take dep on `browsergym` | ❌ | Python + gymnasium + `sync_playwright` fights our Playwright |
 | Take dep on `browsergym-miniwob` | ❌ | Injects `data-browsergym-id` attrs — conflicts with `@e`-ref model |
 | Port task table + JS + protocol | ✅ | 3 ported files, ~400 lines, zero new dependencies |

 The integration surface from BrowserGym is small: 125 task definitions, ~80
 lines of JS injection, and a reward-reading protocol — all trivially
 portable to TypeScript.

### Attribution

- **MiniWoB++** (Farama-Foundation, Apache-2.0) — task definitions, HTML/CSS/JS
- **BrowserGym** (ServiceNow, Apache-2.0) — setup JS injection, reward protocol
- Commit pin: `miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838`

 Tests are not shipped in the published npm package, but both projects are
 credited in every ported file headerdoc. See `helpers/miniwob.ts` for the
 full attribution block.
