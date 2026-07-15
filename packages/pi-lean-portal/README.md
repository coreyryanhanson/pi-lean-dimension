# pi-lean-portal User Guide

> **pi-lean-portal** gives the Pi coding agent interactive web browsing —
> Playwright Chromium/Firefox, accessibility-tree snapshots with `@e` element
> refs, persistent profiles, cookies, and navigation guides that resurface by
> domain. A `/web` toggle removes the tools from the agent's context when
> switched off, so web browsing doesn't consume tokens on sessions that aren't
> doing web work. If a site blocks the shipped browsers, drop in your own
> backend (e.g. [Camoufox](https://github.com/daijro/camoufox)).
>
> Part of the [pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)
> web-tools suite. For SearXNG search support, install
> [`pi-lean-search`](https://www.npmjs.com/package/pi-lean-search).

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Extending it](#extending-it)
3. [`/web` Command — Browser Toggle & Profiles](#web-command--browser-toggle--profiles)
4. [All 12 Tools](#all-12-tools)
5. [Stateless Fetching (web-fetch)](#stateless-fetching-web-fetch)
6. [Navigation Guides (web-guide & web-learn)](#navigation-guides-web-guide--web-learn)
7. [`/web status` — Detailed Runtime Status](#web-status--detailed-runtime-status)
8. [Profiles — Persistent Sessions](#profiles--persistent-sessions)
9. [Cookie Management](#cookie-management)
10. [Backend Architecture](#backend-architecture)
11. [Configuration (settings.json)](#configuration-settingsjson)
12. [Tips & Best Practices](#tips--best-practices)

---

## Quick Start

```bash
pi install npm:pi-lean-portal
npx playwright install chromium firefox
```

Once loaded, you'll see a notification like:

> 🌐 Browser extension loaded (plugins: chromium, firefox). Try: web-fetch for static pages or browser-navigate for interactive browsing.

The browser tools are **enabled by default**. You can:

- **Fetch a static page**: The agent uses `web-fetch` for quick, stateless
  content retrieval (no JavaScript, no session).
- **Browse interactively**: The agent uses `browser-navigate` to visit a page,
  then clicks, types, scrolls, and screenshots using `@e1`/`@e2` element
  references from the accessibility tree.

> **Tip:** If you only need Markdown content from a static page, `web-fetch`
> is faster and lighter than launching a full browser session.
>
> **Playwright browser binaries are not downloaded during `npm install`.**
> Run `npx playwright install chromium firefox` separately. On first
> `browser-navigate` without them, you'll be prompted with the exact command.

---

## Extending it

Beyond the toggle, two surfaces are user-extensible rather than hardcoded:

- **Navigation guides** — `web-learn` saves site-specific playbooks that
  auto-match by domain and resurface in later sessions. See
  [Navigation Guides](#navigation-guides-web-guide--web-learn).
- **Custom browser backends** — if a site blocks the shipped Chromium/Firefox,
  drop a `bridge.py` subclass into `~/.pi/agent/pi-lean-portal/user-backends/`
  and drive a patched engine like [Camoufox](https://github.com/daijro/camoufox)
  yourself. The full flow lives in [Backend Architecture](#backend-architecture)
  and [`contributed/README.md`](./contributed/README.md).

---

## `/web` Command — Browser Toggle & Profiles

The `/web` command controls whether web tools are visible to the AI agent,
toggles guide-saving mode, and manages browser profiles.

### Three-State Toggle

| Command | Effect |
|---------|--------|
| `/web on` | **Browsing only** — all interactive browser tools + `web-fetch` are available. `web-learn` is hidden. If `pi-lean-search` is also installed, `web-search` is enabled too. |
| `/web learn` | **Browsing + guide-saving** — same as `on`, plus the `web-learn` tool is available so the AI can save/update navigation guides on request. |
| `/web off` | **All web tools hidden** — saves ~1500–2000 tokens per turn by removing tool schemas from the prompt. `web-fetch` and `web-search` are also hidden. |

### Check Current State

| Command | Effect |
|---------|--------|
| `/web` | Show current toggle status and available sub-commands. |
| `/web status` | **Detailed runtime status** — toggle state, plugin health, active sessions, and profiles on disk. |

### Why Toggle?

- **`/web off`**: When you're done browsing, turning tools off reduces context
  usage and keeps the agent focused on coding.
- **`/web learn`**: Only enable this when you want the agent to save navigation
  guidance for a site. The agent never calls `web-learn` unprompted — it must
  be in learn mode.
- **State persists** across `/reload`, `/resume`, `/fork`, and `/tree`
  navigation — the toggle remembers what you chose.

### Persistence

The toggle state is stored in the conversation's branch history. A fresh
conversation starts with the default from `settings.json` (`browserToggle.defaultEnabled`,
which defaults to `true`).

---

## All 12 Tools

`pi-lean-portal` registers 12 tools. The first 9 require a **browser session**
(created by `browser-navigate`). `web-fetch`, `web-guide`, and `web-learn` are stateless.

**Auto-captured screenshots:** `browser-navigate` and `browser-snapshot` automatically
capture a screenshot to a temp file (`/tmp/pi-lean-portal/screenshot-<taskId>.jpg`).
Use the `read` tool to visually inspect the page when the accessibility tree isn't enough.
Screenshots capture the 1280×720 viewport (not full-page) — the same viewport the
browser uses for navigation.

### 1. `browser-navigate` — Visit a Page

Navigates to a URL using a browser plugin (default: Chromium). Returns an
accessibility tree annotated with **@e1, @e2, …** element references.

```text
Title: Example Domain
URL: https://example.com
Backend: chromium
Interactive elements: 3

  link "More information..." [@e1]
    → https://www.iana.org/domains/example
  …
```

**Parameters:**

- `url` — the target URL
- `strategy` (optional) — `"auto"` (default) or a plugin name like `"chromium"` or `"firefox"`
- `timeout` (optional) — seconds, default 30, max 120
- `profile` (optional) — `"none"`, `"session"`, or a named profile (see
  [Profiles](#profiles--persistent-sessions))

**Output includes:**

- Page title, URL, backend name, element count
- Profile info when using profiles
- Bot detection warning when applicable
- Screenshot file path for visual inspection
- Guide footer appended when relevant guides apply

### 2. `browser-snapshot` — Refresh the Accessibility Tree

Returns the current page's accessibility tree with up-to-date `@e` refs. Also
captures a screenshot to a temp file (path in output). Use after clicking, typing,
or scrolling to get fresh element references.

- `full=true` — returns the complete tree (by default it's compacted to
  ~2500 characters for LLM efficiency)

### 3. `browser-click` — Click an Element

```text
browser-click ref="@e5"
```

Clicks the element identified by its `@e` reference. Returns a fresh snapshot
of the page after the click.

### 4. `browser-type` — Type Into a Field

```text
browser-type ref="@e3" text="hello world"
```

Clears the input, then types the given text. Works on textboxes, searchboxes,
and comboboxes.

### 5. `browser-scroll` — Scroll the Page

```text
browser-scroll direction="down"
```

Scrolls approximately one viewport height. Returns a fresh snapshot.

### 6. `browser-back` — Go Back

Navigates back in browser history. Returns the previous page's snapshot.

### 7. `browser-press` — Press a Keyboard Key

```text
browser-press key="Enter"
```

Useful keys: `Enter`, `Tab`, `Escape`, `ArrowDown`, `ArrowUp`, `Backspace`.

### 8. `browser-console` — Read Console / Run JS

Three modes:

| Usage | Effect |
|-------|--------|
| `browser-console expression="document.title"` | Evaluates JS and returns the result |
| `browser-console` (no params) | Returns captured console messages (log, warn, error, info) |
| `browser-console clear=true` | Clears the captured console log |

### 9. `browser-inspect` — Targeted Element Discovery

A lighter alternative to loading a full snapshot. Queries the page for specific
elements or extracts text content.

| Parameter | Example | Effect |
|-----------|---------|--------|
| `role` | `"link,button"` | Filter by ARIA role(s) |
| `name` | `"Submit"` | Filter by accessible name (case-insensitive) |
| `ref` | `"e5"` | Look up a specific `@e` ref |
| `subtree` | `"dialog"` | Scope to elements inside a container |
| `text` | `true` | Run DOM text extractor with `@e` annotations |
| `maxChars` | `500` | Limit output length; `0` for full content |
| `query` | `"pricing"` | Keyword filter (only active with `text=true`) |

> **Tip:** Use `browser-inspect role="dialog"` to quickly check for consent
> dialogs without loading the full tree.

---

## Stateless Fetching (`web-fetch`)

`web-fetch` is a lightweight, stateless tool that fetches a URL and converts
HTML to Markdown. It does **not** create a browser session.

**When to use:**

- Static pages, API docs, READMEs, articles
- Quick lookups where JavaScript isn't needed
- When the interactive browser is blocked by bot detection — `web-fetch`
  sometimes succeeds where the browser triggers a challenge

**Output handling:**

- Content is truncated to ~4000 characters inline
- Larger content is spilled to a temp file in `/tmp/pi-lean-portal/` — the agent can `read` the file with offset/limit for specific sections. This cache ensures that the agent can access the full page content even when it exceeds the LLM's immediate context window.
- Bot detection and JS-only shells are detected heuristically

---

## Navigation Guides (`web-guide` & `web-learn`)

### Built-in Pattern Guides

`pi-lean-portal` ships with four built-in pattern guides that appear in the guide footer when relevant:

| Guide | Trigger | What It Covers |
|-------|---------|----------------|
| `bot-detection` | When bot blocking is detected | Cloudflare, challenge pages, what NOT to do |
| `cookie-consent` | When a dialog is detected in the snapshot | Accept/Reject buttons, Escape key, verification |
| `pagination` | On-demand | Next buttons, infinite scroll, pages |
| `search` | On-demand | Search boxes, comboboxes, result lists |

### Viewing Guides

```text
web-guide                           → lists all available guides
web-guide guide="cookie-consent"    → shows guidance text
```

The output includes the guide's last updated date and source (`builtin` or
`user`).

### Creating Your Own Site Guides (`web-learn`)

When the agent is in **learn mode** (`/web learn`), it can save or update
navigation guidance for specific sites using `web-learn`.

```text
web-learn domain="reddit.com" content="…guidance text…"
```

This creates a `.md` file with YAML frontmatter in `~/.pi/agent/pi-lean-portal/web-guides/`.
The guide becomes available immediately via `web-guide` and appears in the guide footer on
future navigations to that domain.

**Learn mode is off by default** — the agent never saves guides unprompted.
You must explicitly enable it with `/web learn`.

---

## `/web status` — Detailed Runtime Status

```text
/web status
```

Shows everything about the browser runtime in one notification:

```text
🌐 Browser tools: ✅ on  |  📖 Learn mode: ❌ off
────────────────────────────────────────
Status: idle
Plugins: chromium, firefox, chromium-py (disabled), firefox-py (disabled)
Use web-fetch for stateless HTTP fetches.
Active sessions: 1
  PW [chromium] https://example.com — Example Domain [profile: session]
Profiles: 1 on disk (named)
  shopping  (0.3 KB) ← active
Session profiles: 1 (manage with /web profile)
```

Covers:

- **Toggle state** — whether browser/learn tools are active in the agent's context
- **Backend health** — idle, busy, or error state
- **All registered plugins** — enabled/disabled status
- **Active sessions** — current URL, title, profile name per session
- **Profiles on disk** — named profiles with state size and which is
  currently active; session profiles are collapsed into a single count line
  (inspect individually with `/web profile list`)

When `pi-lean-search` is also installed, the status bar shows two independent
glyphs: `● idle` (browser state) and `● searxng` (search health/state).

---

## Profiles — Persistent Sessions

Profiles let the AI agent maintain persistent browser state (cookies,
localStorage) across calls, conversations, and even across different subagents.

### Profile Modes

| Mode | `browser-navigate profile=` | Behavior |
|------|-----------------------------|----------|
| None | `"none"` | Clean slate every time — no cookies, no state |
| Session | `"session"` (default) | Persists state for the current conversation; survives `/reload` and `/resume` |
| Named | `"shopping"`, `"work"`, etc. | Shared across conversations and subagents — like browser tabs sharing a profile |

### Managing Profiles with `/web profile`

All profile management happens through the `/web profile` command:

| Sub-command | Effect |
|-------------|--------|
| `/web profile list` | List all profiles on disk with their state size |
| `/web profile create shopping` | Create a new named profile |
| `/web profile session` | Set conversation-scoped default to session mode |
| `/web profile none` | Reset default to ephemeral (no persistence) |
| `/web profile shopping` | Switch default profile to an existing named profile |
| `/web profile clear shopping` | Delete the saved state for a profile (keeps the directory) |
| `/web profile clear-all --confirm` | Clear ALL profile states |
| `/web profile prune --confirm` | Remove stale session profiles for ended conversations |

> **How it works:** Profile state is stored at
> `~/.pi/agent/pi-lean-portal/browser-state/<profile-name>/storage-state.json`.
> Session-scoped profiles use names like `_session-<piSessionId>` and are
> auto-cleaned when the pi conversation ends.

---

## Cookie Management

The `/web cookies` command lets you inspect and clear session cookies:

| Sub-command | Effect |
|-------------|--------|
| `/web cookies list` | List all cookies in the current session (name, value, domain, expiry, flags) |
| `/web cookies clear --confirm` | Clear ALL cookies for the current session |

> Cookies are saved as part of profile state. When you switch profiles,
> the cookies from the old profile are preserved and the new profile's
> cookies are loaded.

---

## Backend Architecture

`pi-lean-portal` uses a **plugin-based architecture**. The core framework is
backend-agnostic — plugins implement a standard `BrowserPlugin` interface,
and the router dispatches tool calls to the right plugin based on a
`strategy` parameter.

### Four Shipped Backends

The extension ships with **four browser backends** out of the box:

| Backend | Engine | Type | Default |
|---------|--------|------|---------|
| `chromium` | Chromium | Node/Playwright | **Enabled** (auto strategy) |
| `firefox` | Firefox | Node/Playwright | **Enabled** |
| `chromium-py` | Chromium | Python/Playwright | Disabled |
| `firefox-py` | Firefox | Python/Playwright | Disabled |

> **Install Firefox:** `npx playwright install firefox` to use the Node
> `firefox` backend. For the Python parity backends, install Playwright
> inside `backends/python-base/.venv`.

### Plugin Capabilities

All four shipped backends share the same capability set (they all use
Playwright under the hood). The router adapts based on each plugin's
capability advertisement:

| Capability | Chromium / Firefox (Node) | `-py` backends (Python) |
|------------|--------------------------|------------------------|
| Full-page screenshots | ✅ | ✅ |
| Console message capture | ✅ | ✅ |
| JavaScript evaluation | ✅ | ✅ |
| Bot detection | ✅ | ✅ |
| Dialog auto-dismissal | ✅ | ✅ |
| AbortSignal support | ✅ | Advertised, silently ignored |

> The `-py` Python backends are disabled by default. They ship as parity
> references for the Python bridge contract and as templates for users
> authoring their own Python-based backends (see the custom backends
> section below). Keep `chromium-py` as a reference when reading the
> bridge code.

### How Plugin Selection Works

- The **order** of plugins in the config array determines priority — the
  first enabled plugin is the "auto" default (typically Chromium).
- The **AI agent explicitly selects** which backend to use via the
  `strategy` parameter in `browser-navigate`:
  - `strategy="auto"` → uses the first enabled plugin (typically Chromium)
  - `strategy="firefox"` → uses the Firefox Node backend
  - `strategy="chromium-py"` → uses the Python Chromium backend
- **No automatic fallbacks** and **no mid-session transitions** — if a
  plugin fails, the agent decides what to do next.
- The extension auto-detects whether a plugin is Node-based (`index.ts`)
  or Python-based (`bridge.py`) by inspecting the directory.

### Stealth & Custom Browser Backends

This package ships four backends — `chromium`, `firefox`, `chromium-py`,
and `firefox-py` — all built on Playwright. Additional browser support
(including stealth engines like **Camoufox**) is intentionally **left
to users** to author and drop in, rather than being bundled with the
package. The infrastructure for this is now in place: a **quirks system**
lets a backend declare how it diverges from the base Playwright behavior,
and a **config channel** (`browser.init` RPC) forwards launch options
from `settings.json` to the Python bridge subprocess.

Most users will never need a stealth backend (see
[`contributed/CHOOSING.md`](./contributed/CHOOSING.md) for when to reach
for one at all). When you do, the flow is:

1. **Drop a `bridge.py` into the user-backends tree.** The convention is
   `~/.pi/agent/pi-lean-portal/user-backends/<name>-py/bridge.py` (the
   `-py` suffix mirrors the shipped `chromium-py` / `firefox-py`). This is
   a separate tree from the package's own `backends/` directory, which is
   not edited after install — exactly so custom backends survive updates.
2. **Create a venv and fetch the engine binary** (e.g.
   `python -m camoufox fetch`). The shared `pi_browser_bridge` library is
   injected onto `PYTHONPATH` automatically at spawn time, so you do not
   need to `pip install` it.
3. **Register it in `browser.plugins`** with an **absolute** `pythonPath`
   and a `launch` object whose keys are forwarded to the bridge.
4. **Verify with `/web status`** and a `browser-navigate`.

The shipped **Camoufox template** at
[`contributed/camoufox-py/bridge.py`](./contributed/camoufox-py/bridge.py)
is a worked example — copy it as a starting point. The full install flow,
the quirks schema reference, and the security model (user-backends are
**trusted user code** — never auto-downloaded, no plugin marketplace) live
in [`contributed/README.md`](./contributed/README.md). The decision doc at
[`contributed/CHOOSING.md`](./contributed/CHOOSING.md) covers when to use
a stealth backend at all and the two lifecycle patterns for implementing
your own.

#### Writing your own backend (high level)

A custom Python backend is a subclass of `PlaywrightBridge`
(`backends/python-base/pi_browser_bridge/playwright_base.py`) that sets
the **quirks flags** its engine needs as class attributes and overrides
the launch hook matching how the engine owns Playwright. The flags
(`_fingerprint_managed_context`, `_eval_prefix`, `_scroll_via_wheel`,
`_skip_default_viewport`, `_skip_networkidle`, `_wrap_mw_eval_in_eval`)
all default off, so a subclass that sets none of them is bit-identical to
the shipped `chromium-py` / `firefox-py`. The full table with effects is
in [`contributed/README.md`](./contributed/README.md#quirks-schema-reference).

Node-based custom backends follow the same shape via the
`PlaywrightPluginBase` class — the auto-detection in `plugin-loading`
picks up `index.ts` (Node) or `bridge.py` (Python) entry points from the
user-backends directory.

#### Tests are auto-discovered

You usually do **not** need to write your own tests. The contributed
runner at `__tests__/run-contributed-suites.test.ts` discovers every
backend under `user-backends/*-py/`, loads config from the test-local
`settings.json`, and runs the shared contract + persistence + parity +
quirks-introspection suites against it — forwarding your configured
`launch` options. Opt in with `CONTRIB_RUN=1`:

```bash
npm run setup:miniwob   # one-time: clone MiniWoB++ content
CONTRIB_RUN=1 npx vitest run packages/pi-lean-portal/__tests__/run-contributed-suites.test.ts
```

A custom backend's config entry looks like:

```jsonc
{
  "browser": {
    "plugins": [
      { "name": "chromium", "dir": "chromium", "enabled": true, "config": {} },
      { "name": "firefox", "dir": "firefox", "enabled": true, "config": {} },
      { "name": "camoufox-py", "dir": "camoufox-py", "enabled": true, "config": {
          "pythonPath": "/home/me/.pi/agent/pi-lean-portal/user-backends/camoufox-py/.venv/bin/python",
          "launch": { "headless": true, "os": "windows", "humanize": true }
        }
      }
    ]
  }
}
```

`pythonPath` must be **absolute**; `dir` resolves against the user-backends
root (multi-root discovery: package `backends/` → `USER_BACKENDS_DIR` →
absolute). `launch` keys are forwarded to the bridge as
`plugin_config.launch` via the `browser.init` RPC. Stealth backends are
never in the default fallback list — a fresh install with no
`browser.plugins` loads only the four shipped backends.

---

## Configuration (`settings.json`)

Browser settings are read from `~/.pi/agent/settings.json` (global) and
`.pi/settings.json` (project-local, overrides global).

### `browser.plugins` Array

Controls which browser backends are loaded. Entries are processed in order
(the first enabled plugin is the `"auto"` default).

```jsonc
{
  "browser": {
    "plugins": [
      {
        "name": "chromium",    // Required: unique plugin identifier
        "dir": "chromium",     // Required: directory under backends/
        "enabled": true,       // Optional, defaults to true
        "config": {}           // Optional, passed to the plugin's init()
      }
    ]
  }
}
```

Each entry requires only a unique name, a backend directory path, and an
optional `config` object passed to the plugin's `init()`. For the Python
backends, `config` carries `pythonPath` and a `launch` object (the shape
shown for `camoufox-py` in the [Stealth & Custom Browser Backends](#stealth--custom-browser-backends)
section above is the reference for a user-authored Python backend).

### `browser.defaultProfile`

The profile mode or named profile used when `browser-navigate` doesn't specify
a `profile` parameter:

```jsonc
{
  "browser": {
    "defaultProfile": "session"   // "none", "session", or a named profile string
  }
}
```

### `browserToggle.defaultEnabled`

Whether browser tools are enabled on fresh conversations:

```jsonc
{
  "browserToggle": {
    "defaultEnabled": true
  }
}
```

### `browser.maxStorageStateSize`

Size threshold for profile state warnings (default: 10 MB):

```jsonc
{
  "browser": {
    "maxStorageStateSize": 10485760
  }
}
```

---

## Tips & Best Practices

### When to use `web-fetch` vs `browser-navigate`

| Use `web-fetch` | Use `browser-navigate` |
|-----------------|----------------------|
| Static content, docs, READMEs | Interactive pages, JS-heavy SPAs |
| Quick lookups, no session needed | Form filling, clicking, authentication |
| Bot-detected pages (fallback) | Visual inspection (auto-captured screenshots) |
| Content you want as clean Markdown | Pages where you need the accessibility tree |

### Working with `@e` Element References

- `@e1`, `@e2`, etc. are assigned based on the accessibility tree order
- `browser-click`/`type`/`scroll` already return a fresh snapshot and cache
  the full tree to disk — no separate `browser-snapshot` needed unless you
  want the uncompacted tree (`full=true`) or a screenshot
- `browser-inspect` is cheaper than `browser-snapshot full=true` for finding
  specific elements

### Navigating Large Pages

- Snapshots are automatically compacted to ~2500 characters
- Very large pages (>8000 chars) preserve the top ~2000 chars
- The **full tree is cached to disk** at `/tmp/pi-lean-portal/snapshot-*.txt`
  when it would otherwise be truncated — use `read` on the cache file with
  offset/limit to retrieve the complete tree
- `browser-inspect text=true query="keyword"` finds specific content without
  loading the full tree

### Bot Detection

When a page triggers anti-automation:

1. The agent sees a warning in the navigate output
2. The **bot-detection guide** footer appears with strategies available via `web-guide`
3. If very few elements are detected (<5), the navigation is treated as
   a hard failure — the agent won't try to interact with a challenge page
4. Retry with a stealth backend — the `browser-navigate` `strategy`
   parameter lists registered backend names; a stealth backend (e.g.
   `strategy="camoufox"`) can pass challenges the default `chromium`/
   `firefox` triggers. Only names listed in the `strategy` description
   are valid — there is no `"stealth"` alias
5. Try `web-fetch` on the same URL — it skips JS execution, so it can
   retrieve raw HTML on pages that block the interactive browser via
   client-side fingerprinting (it won't help against server-side WAFs)

### Guide Creation Discipline

When creating navigation guides with `web-learn`:

- Keep guidance **concise** (≤800 chars recommended)
- Focus on: page structure, consent dialogs, known quirks, and useful
  selector patterns
- Include domains so the guide appears in the footer on future navigations
- No runtime enforcement on guide length, but brevity helps the LLM

### Security

- URLs are validated against private IP ranges (10.x, 172.16-31.x,
  192.168.x, 127.x, 169.254.169.254) — localhost and internal networks
  are blocked by default
- Dangerous URL schemes are blocked: `file:`, `ftp:`, `data:`,
  `javascript:`, `vbscript:`
- Secrets in URLs are detected heuristically
- Profile state is stored with restricted file permissions (0700 dirs,
  0600 files)

---

> `pi-lean-portal` is part of the
> [pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)
> web-tools suite. For questions, issues, or feature requests, check the
> project's documentation or open an issue.
>
> License: AGPL-3.0-only
