 Research: Simulated Websites for Agent Browser Integration Tests

 This is not an unrealistic goal at all — there's actually a thriving ecosystem of precisely what you're looking for, born from the AI agent benchmarking wave. Here's what I found:

 ────────────────────────────────────────────────────────────────────────────────

 ### Tier 1: Self-Hosted Realistic Web Environments (Highest Fidelity)

 #### 1. REAL (agi-inc/REAL (https://github.com/agi-inc/REAL))

 - What it is: Deterministic, high-fidelity replicas of 11 real-world apps — Amazon, Uber, Airbnb, Gmail, Google Calendar, DoorDash, United Airlines, OpenTable, LinkedIn, UpWork, Zillow
 - 112 human-written tasks ("Buy a laptop", "Book a flight", "Compose an email")
 - Programmatic state verification + LLM-guided evaluation for info retrieval
 - Leaderboard at realevals.xyz (https://www.realevals.xyz)
 - ⚠️ Only 7 stars — still very new (May 2025), AGI Inc. backed

 #### 2. WebArena (web-arena-x/webarena (https://github.com/web-arena-x/webarena)) ⭐ Most mature

 - 1.5k stars, Apache-2.0, paper from Stanford (NeurIPS 2023)
 - Self-hostable Docker containers mimicking 4 categories:
     - Shopping site (admin panel included)
     - Social forum
     - Developer CMS (WordPress-like)
     - Collaborative whiteboard
 - ~800 eval tasks via browser automation traces from human annotators
 - Requires setting up your own instances with Docker — not trivial but documented
 - Has a newer variant: WebArena-Infinity which auto-generates environments from app docs using Claude Code

 #### 3. BrowserGym (ServiceNow/BrowserGym (https://github.com/ServiceNow/BrowserGym)) ⭐ Most comprehensive framework

 - 1.3k stars, actively maintained (v0.14.3, Jan 2026)
 - Gymnasium interface for web agent benchmarking — wraps ALL of the above
 - Ships with 8 built-in benchmarks: MiniWoB++, WebArena, VisualWebArena, WorkArena, AssistantBench, WebLINX, OpenApps, TimeWarp
 - Easy pip install browsergym + playwright install chromium
 - You can create custom tasks by extending AbstractBrowserTask
 - This is probably your best starting point

 ────────────────────────────────────────────────────────────────────────────────

 ### Tier 2: Synthetic but Sophisticated Task Libraries (Easiest to Use)

 #### MiniWoB++ (miniwob.farama.org (https://miniwob.farama.org/)) — Part of BrowserGym

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
