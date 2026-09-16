# pi-lean-portal User Guide

> **pi-lean-portal** gives the Pi coding agent interactive web browsing via Playwright Chromium/Firefox, accessibility-tree snapshots with `@e` element
> refs, persistent profiles, cookies, and domain-aware navigation guides. A `/web` toggle removes the tools from the agent's context when
> switched off, so web browsing doesn't consume tokens on sessions that aren't
> doing web work. If a site blocks the shipped browsers, drop in your own
> backend (e.g. [Camoufox](https://github.com/daijro/camoufox)).
>
> Part of the [pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension)
> web-tools suite. For SearXNG search support, install
> [`pi-lean-search`](https://www.npmjs.com/package/pi-lean-search).

---

## Quick Start

```bash
pi install npm:pi-lean-portal
```

Then run **`/web install`** inside pi to download browser binaries (these are not installed via npm).

Once loaded, you'll see a notification like:

> 🌐 Browser extension loaded (plugins: chromium, firefox). Try: web-fetch for static pages or browser-navigate for interactive browsing.

The browser tools are **enabled by default**: `web-fetch` for static pages,
`browser-navigate` (plus click/type/scroll/screenshots via `@e` refs) for
interactive browsing.

---

## `/web` Command — Browser Toggle & Profiles

The `/web` command controls whether web tools are visible to the AI agent,
toggles guide-saving mode, and manages browser profiles.

### Three-State Toggle

| Command | Effect |
| ------- | ------ |
| `/web on` | **Browsing only**: all interactive browser tools + `web-fetch` are available. `web-learn` is hidden. If `pi-lean-search` is also installed, `web-search` is enabled too. |
| `/web learn` | **Browsing + guide-saving**: same as `on`, plus the `web-learn` tool is available so the AI can save/update navigation guides on request. |
| `/web off` | **All web tools hidden**: saves ~1500–2000 tokens per turn by removing tool schemas from the prompt. `web-fetch` and `web-search` are also hidden. |

### Check Current State

| Command | Effect |
| ------- | ------ |
| `/web` | Show current toggle status and available sub-commands. |
| `/web status` | **Detailed runtime status** including toggle state, plugin health, browser-binary presence, active sessions, and profiles on disk. |
| `/web install` | **Install browser binaries** via the bundled playwright CLI (checkbox dialog in the TUI; prints the manual command elsewhere). |
| `/web install chromium\|firefox` | Directly download one engine, no dialog. |

```text
🌐 Browser tools: ✅ on  |  📖 Learn mode: ❌ off
────────────────────────────────────────
Status: idle
Plugins: chromium, firefox, chromium-py (disabled), firefox-py (disabled)
Browsers: chromium ✓ firefox ✓
Use web-fetch for stateless HTTP fetches.
Active sessions: 1
  PW [chromium] https://example.com — Example Domain [profile: session]
Profiles: 1 on disk (named)
  shopping  (0.3 KB) ← active
Session profiles: 1 (manage with /web profile)
```

### Persistence

Toggle state persists across `/reload`, `/resume`, `/fork`, and `/tree` — it's
stored in the conversation's branch history. Fresh conversations start from
the `toolsetDefaults` block in `settings.json`
([Configuration](#configuration-settingsjson)).

---

## Profiles — Persistent Sessions

Profiles let the AI agent maintain persistent browser state (cookies,
localStorage) across calls, conversations, and even across different subagents.

### Profile Modes

| Mode | `browser-navigate profile=` | Behavior |
| ---- | --------------------------- | -------- |
| None | `"none"` | Clean slate every time (no cookies or state) |
| Session | `"session"` (default) | Persists state for the current conversation; survives `/reload` and `/resume` |
| Named | `"shopping"`, `"work"`, etc. | Shared across conversations and subagents, similar to browser tabs sharing a profile |

### Managing Profiles with `/web profile`

| Sub-command | Effect |
| ----------- | ------ |
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
> Session-scoped profiles are auto-cleaned when the pi conversation ends.

---

## Cookie Management

The `/web cookies` command lets you inspect and clear session cookies:

| Sub-command | Effect |
| ----------- | ------ |
| `/web cookies list` | List all cookies in the current session (name, value, domain, expiry, flags) |
| `/web cookies clear --confirm` | Clear ALL cookies for the current session |

> Cookies are saved as part of profile state. When you switch profiles,
> the cookies from the old profile are preserved and the new profile's
> cookies are loaded.

---

## All 12 Tools

`pi-lean-portal` registers 12 tools. Three are **stateless**; the rest require
a **browser session** (created by `browser-navigate`).

| Tool | What it does | State |
| ---- | ------------ | ----- |
| `web-fetch` | Fetch a URL → Markdown, no browser session | stateless |
| `web-guide` / `web-learn` | Read / save navigation guides (learn mode via `/web learn`) | stateless |
| `browser-navigate` | Open a page → accessibility tree with `@e` element refs | session |
| `browser-snapshot` | Refresh the tree (`full=true` returns the uncompacted tree) | session |
| `browser-click` / `browser-type` / `browser-scroll` / `browser-back` / `browser-press` | Interact via `@e` refs (click, type, scroll, history, keyboard) | session |
| `browser-console` | Read captured console messages; also evaluates JS in the page | session |
| `browser-inspect` | Targeted element/text queries without loading a full snapshot | session |

### Automatic Artifacts

Session tools save their full output to disk so the agent never needs a second call:

- **Screenshots**: `browser-navigate` and `browser-snapshot` auto-capture a viewport-sized (1280×720) JPEG to `/tmp/pi-lean-portal/screenshot-<taskId>.jpg`[^1].
- **Full Snapshots**: Any snapshot compacted for size is cached in full at `/tmp/pi-lean-portal/snapshot-*.txt` (last 2 per task).

Both file paths are surfaced as hints in the tool output, which the agent can follow up with the `read` tool.

[^1]: Not full-page.

---

## Navigation Guides

### Built-in Pattern Guides

`pi-lean-portal` ships with four built-in pattern guides that appear in the guide footer when relevant:

| Guide | Trigger | What It Covers |
| ----- | ------- | -------------- |
| `bot-detection` | Bot blocking detected (`botDetected`) | Cloudflare, challenge pages, what NOT to do |
| `cookie-consent` | Dialog detected (`dialogDetected`) | Accept/Reject buttons, Escape key, verification |
| `pagination` | On-demand | Next buttons, infinite scroll, pages |
| `search` | On-demand | Search boxes, comboboxes, result lists |

### Overriding Built-in Guides

A same-named `.md` file in `~/.pi/agent/pi-lean-portal/web-guides/` (e.g.
`bot-detection.md`) **shadows the builtin entirely**; the whole guide is
replaced, not field-merged. To keep a pattern guide firing, include
`trigger.signal: botDetected` (or `dialogDetected`) in the frontmatter;
omitting it disables the trigger.

```yaml
---
category: pattern
trigger.signal: botDetected
icon: 🤖
shortName: my bot guide
---
Custom guidance text for bot challenges.
```

Site guides and pattern guides live in **disjoint namespaces** — a site guide
for `www.botdetection.com` does not collide with the `bot-detection` pattern
guide; both fire when applicable.

### Domain Matching

A guide's declared domain matches the **exact hostname or any subdomain of
it**. Declaring `reddit.com` covers `www.reddit.com`, `old.reddit.com`, and
any other subdomain, so a guide saved once resurfaces across a site's URL
variations. This is what makes guides cheap to author: you rarely need more
than the apex domain. A domain may match multiple guides (a web guide plus
one or more API guides) — all matching guides surface together, sorted
host-first (API guides before web guides).

### API guides from `pi-lean-host` (co-install)

When `pi-lean-host` is installed alongside portal and `/api` is on, its
user-authored API guides also **surface in the navigate footer** alongside
your web guides using the same reactive mechanism, with no extra setup. API guides sort
first (API access is cheaper than browsing) but both always appear, so a
partial-coverage API keeps its web guide for the gaps the API doesn't cover.
The footer routes API guides to `api-guide({domain, guide})` rather than
`web-guide`. See the
[host README](https://github.com/coreyryanhanson/pi-lean-dimension/blob/main/packages/pi-lean-host/README.md#co-installing-with-pi-lean-portal)
for the host side of the contract.

---

## Backend Architecture

`pi-lean-portal` uses a **plugin-based architecture**. The core framework is
backend-agnostic; plugins implement a standard `BrowserPlugin` interface,
and the router dispatches tool calls to the right plugin based on a
`strategy` parameter.

### Four Shipped Backends

| Backend | Engine | Type | Default |
| ------- | ------ | ---- | ------- |
| `chromium` | Chromium | Node/Playwright | **Enabled** (auto strategy) |
| `firefox` | Firefox | Node/Playwright | **Enabled** |
| `chromium-py` | Chromium | Python/Playwright | Disabled |
| `firefox-py` | Firefox | Python/Playwright | Disabled |

> **Install Firefox:** run `/web install firefox` inside pi to download the
> Firefox binary for the Node `firefox` backend. For the Python parity
> backends, install Playwright inside `backends/python-base/.venv`.

All four shipped backends support screenshots (viewport-sized, not
full-page), console capture, JS evaluation, bot detection, and dialog
auto-dismissal. The one divergence:
`AbortSignal` is advertised but silently ignored on the Python `-py` backends.

> The `-py` backends are disabled by default, as they ship as parity references
> for the Python bridge contract and as templates for authoring your own
> Python-based backends.

### How Plugin Selection Works

- The **order** of plugins in the config array determines priority; the
  first enabled plugin is the "auto" default (typically Chromium).
- The **AI agent explicitly selects** which backend to use via the
  `strategy` parameter in `browser-navigate`:
  - `strategy="auto"` → uses the first enabled plugin (typically Chromium)
  - `strategy="firefox"` → uses the Firefox Node backend
  - `strategy="chromium-py"` → uses the Python Chromium backend
- **No automatic fallbacks** and **no mid-session transitions**. If a
  plugin fails, the agent decides what to do next.

### Stealth & Custom Browser Backends

Stealth engines like **Camoufox** are intentionally **left to users** to
author: drop a `bridge.py` into
`~/.pi/agent/pi-lean-portal/user-backends/<name>-py/` — a separate tree
from the package's `backends/` directory (never edited after install,
so custom backends survive updates) and never in the default fallback list.
Register one in `browser.plugins` with an **absolute** `pythonPath` (see
[Configuration](#configuration-settingsjson)).

The full install flow, the quirks schema, and the worked Camoufox template
live in
[`contributed/README.md`](https://github.com/coreyryanhanson/pi-lean-dimension/blob/main/packages/pi-lean-portal/contributed/README.md);
[`contributed/CHOOSING.md`](https://github.com/coreyryanhanson/pi-lean-dimension/blob/main/packages/pi-lean-portal/contributed/CHOOSING.md)
covers when to reach for one at all (most users never need one).
Node-based custom backends follow the same shape via `PlaywrightPluginBase`.

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
        "dir": "chromium",     // Required: backend directory
        "enabled": true,       // Optional, defaults to true
        "config": {}           // Optional, passed to the plugin's init()
      }
    ]
  }
}
```

A user-installed stealth backend additionally puts an **absolute** `pythonPath`
and a `launch` object into `config` — see
[`contributed/README.md`](https://github.com/coreyryanhanson/pi-lean-dimension/blob/main/packages/pi-lean-portal/contributed/README.md#6-register-in-settingsjson).

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

### `toolsetDefaults`

Whether browser tools are enabled on fresh conversations. Read by the
`pi-tool-masking` library at restore time, between the chat-branch tier and
the toolset's packaged default:

```jsonc
{
  "toolsetDefaults": {
    "toolset-state:pi-lean-dimension.web": { "enabled": true },
    "toolset-state:pi-lean-dimension.web-learn": { "enabled": false },
    "toolset-state:pi-lean-dimension.search": { "enabled": true }
  }
}
```

- Keys are the toolsets' `persistKey` values (`toolset-state:<id>`).
- Omit a `toolsetDefaults` key to use the toolset's packaged default (`web`
  and `search` default `true`; `web-learn` defaults `false`).
- The `search` key only applies when `pi-lean-search` is installed.
- Pins do not apply in spawned subagent children (see pi-tool-masking
  1.3.0's `piToolMasking.childPolicy` for the opt-out).

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
| --------------- | ---------------------- |
| Static content, docs, READMEs | Interactive pages, JS-heavy SPAs |
| Quick lookups, no session needed | Form filling, clicking, authentication |
| Content you want as clean Markdown | Visual inspection (auto-captured screenshots), pages where you need the accessibility tree |

### Working with `@e` Element References & Large Pages

The agent interacts via `@e1`, `@e2` refs from the accessibility tree —
no CSS selectors or XPath. Snapshots are auto-compacted to ~2500 chars;
full trees and screenshots spill to `/tmp/pi-lean-portal/` (paths are
surfaced in tool output).

### Bot Detection

When a page triggers anti-automation, the agent sees a warning plus a
bot-detection guide footer, and challenge pages with <5 visible elements
fail hard rather than being interacted with. If a site consistently blocks
the shipped Chromium/Firefox, that's the trigger to install a stealth
backend (see [Stealth & Custom Browser Backends](#stealth--custom-browser-backends)) —
not something to configure up front.

### Security

- URLs are parsed with `new URL()` as input validation. Malformed
  URLs are rejected, but no SSRF boundary is enforced (a coding agent
  already has filesystem and shell access, so blocking localhost or
  private IPs would be theater)
- Profile state is stored with restricted file permissions (0700 dirs,
  0600 files)

---

> License: AGPL-3.0-only
