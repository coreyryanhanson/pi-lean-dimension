# pi-browser User Guide

> **pi-browser** is a plugin-based web browsing extension for the pi coding
> agent. It gives the AI agent the ability to fetch web pages, interact with
> dynamic sites, inspect page structure, take screenshots, run JavaScript,
> and save/recall navigation guides — all through a set of tools and commands.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [`/web` Command — Browser Toggle & Profiles](#web-command--browser-toggle--profiles)
3. [All 12 Tools](#all-12-tools)
4. [Stateless Fetching (web-fetch)](#stateless-fetching-web-fetch)
5. [Navigation Guides (web-guide & web-learn)](#navigation-guides-web-guide--web-learn)
6. [`/web status` — Detailed Runtime Status](#web-status--detailed-runtime-status)
7. [Profiles — Persistent Sessions](#profiles--persistent-sessions)
8. [Cookie Management](#cookie-management)
9. [Backend Architecture](#backend-architecture)
10. [Configuration (settings.json)](#configuration-settingsjson)
11. [Tips & Best Practices](#tips--best-practices)

---

## Quick Start

Once pi-browser is loaded (it loads automatically when installed), you'll see a
notification like:

> 🌐 Browser extension loaded (plugins: chromium, firefox)

The browser tools are **enabled by default**. You can:

- **Fetch a static page**: The agent uses `web-fetch` for quick, stateless
  content retrieval (no JavaScript, no session).
- **Browse interactively**: The agent uses `browser-navigate` to visit a page,
  then clicks, types, scrolls, and screenshots using `@e1`/`@e2` element
  references from the accessibility tree.

> **Tip:** If you only need Markdown content from a static page, `web-fetch`
> is faster and lighter than launching a full browser session.

---

## `/web` Command — Browser Toggle & Profiles

The `/web` command controls whether browser tools are visible to the AI agent,
toggles guide-saving mode, and manages browser profiles.

### Three-State Toggle

| Command | Effect |
|---------|--------|
| `/web on` | **Browsing only** — all interactive browser tools + `web-fetch` are available. `web-learn` is hidden. |
| `/web learn` | **Browsing + guide-saving** — same as `on`, plus the `web-learn` tool is available so the AI can save/update navigation guides on request. |
| `/web off` | **All browser tools hidden** — saves ~1500–2000 tokens per turn by removing tool schemas from the prompt. `web-fetch` is also hidden. |

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

Pi-browser registers 12 tools. The first 9 require a **browser session**
(created by `browser-navigate`). `web-fetch`, `web-guide`, and `web-learn` are stateless.

**Auto-captured screenshots:** `browser-navigate` and `browser-snapshot` automatically
capture a screenshot to a temp file (`/tmp/pi-browser/screenshot-<taskId>.jpg`).
Use the `read` tool to visually inspect the page when the accessibility tree isn't enough.
No viewport resizing occurs — screenshots are captured at the native 1280px width.

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

Useful keys: `Enter`, `Tab`, `Escape`, `ArrowDown`, `ArrowUp`, `/`.

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
- Larger content is spilled to a temp file in `/tmp/pi-browser/` — the agent can `read` the file with offset/limit for specific sections. This cache ensures that the agent can access the full page content even when it exceeds the LLM's immediate context window.
- Bot detection and JS-only shells are detected heuristically

---

## Navigation Guides (`web-guide` & `web-learn`)

### Built-in Pattern Guides

Pi-browser ships with four built-in pattern guides that appear in the guide footer when relevant:

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

This creates a `.md` file with YAML frontmatter in the `guides/` directory.
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
Plugins: chromium
Active sessions: 1
  PW [chromium] https://example.com — Example Domain [profile: session]
Profiles: 2 on disk
  📋 session  (2.1 KB) ← active
  shopping  (0.3 KB)
```

Covers:

- **Toggle state** — whether browser/learn tools are active in the agent's context
- **Backend health** — idle, busy, or error state
- **All registered plugins** — enabled/disabled status
- **Active sessions** — current URL, title, profile name per session
- **Profiles on disk** — state size and which one is currently active

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
> `~/.pi/agent/browser-state/<profile-name>/storage-state.json`.
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

Pi-browser uses a **plugin-based architecture**. The core framework is
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
> references for developers building custom Python-based stealth plugins.
> When building your own Python plugin, keep `chromium-py` as a reference.

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

### Adding Custom Stealth Browsers

You can manually add additional backends by:

1. **Creating a backend directory** under `backends/` — either:
   - A **Node.js plugin** with an `index.ts` entry point
   - A **Python plugin** with a `bridge.py` entry point

2. **Registering the plugin** in your `settings.json` under `browser.plugins`:

   ```jsonc
   {
     "browser": {
       "plugins": [
         { "name": "chromium", "dir": "chromium", "enabled": true, "config": {} },
         { "name": "firefox", "dir": "firefox", "enabled": true, "config": {} },
         { "name": "camoufox", "dir": "camoufox", "enabled": false, "config": {
             "pythonPath": "/path/to/venv/bin/python",
             "binaryPath": "/path/to/stealth-browser"
           }
         }
       ]
     }
   }
   ```

3. **Enabling or disabling** plugins without modifying source code (the
   `enabled` field).

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

Each entry requires only a unique name, a backend directory path, and optional
configuration overrides (like Python or binary paths for stealth plugins).

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
- After clicking or scrolling, **always take a fresh snapshot** — old `@e`
  refs become stale
- `browser-inspect` is cheaper than `browser-snapshot full=true` for finding
  specific elements

### Navigating Large Pages

- Snapshots are automatically compacted to ~2500 characters
- Very large pages (>8000 chars) preserve the top ~2000 chars
- The **full tree is cached to disk** at `/tmp/pi-browser/snapshot-*.txt` —
  you can use `read` on the cache file with offset/limit
- `browser-inspect text=true query="keyword"` finds specific content without
  loading the full tree

### Bot Detection

When a page triggers anti-automation:

1. The agent sees a warning in the navigate output
2. The **bot-detection guide** footer appears with strategies available via `web-guide`
3. If very few elements are detected (<5), the navigation is treated as
   a hard failure — the agent won't try to interact with a challenge page
4. Try `web-fetch` on the same URL — it sometimes succeeds where the
   interactive browser doesn't

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

> pi-browser is maintained as part of the [pi coding agent](https://pi.ai)
> ecosystem. For questions, issues, or feature requests, check the
> project's documentation or open an issue.
