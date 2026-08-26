# pi-lean-dimension

> Web browsing, search, and API tools for [Pi](https://github.com/earendil-works/pi), the AI coding agent.

A monorepo housing three Pi extension packages that give your AI agent the
ability to browse the web interactively, fetch static pages as Markdown, search
via SearXNG, and call REST APIs through declarative recipe guides. Each surface
has its own toggle — `/web` for the browser tools, `/api` for the API tools —
so the ones you aren't using are removed from the agent's context entirely and
don't consume tokens or attention on sessions that aren't doing that work.
The recommended install is browser + API (`pi-lean-portal` + `pi-lean-host`);
search is an optional add-on when you run a SearXNG instance. The suite is also
user-extensible: author navigation or API guides that resurface by domain, or
drop in a stealth browser backend like [Camoufox](https://github.com/daijro/camoufox)
when a site blocks the shipped Chromium/Firefox.

## Quick start (recommended)

```bash
pi install npm:pi-lean-portal
pi install npm:pi-lean-host
npx playwright install chromium firefox
```

That's it — the tools are registered. The core browsing and API tools are on by
default; the guide-authoring tools stay off until you opt in. Control them with
`/web on|off|learn` (`on` = browser tools, `learn` = adds `web-learn` for
guide-saving, `off` = everything off) and `/api on|off|learn` (`on` =
`api-guide` + `api-fetch`, `learn` = adds `api-learn` + `api-probe` +
`api-scaffold` for guide authoring, `off` = everything off). Each toggle's state
persists per session independently. To set a different default for **new**
sessions, add a `toolsetDefaults` block to your Pi settings
(`~/.pi/agent/settings.json` or `.pi/settings.json`):

```json
{
  "toolsetDefaults": {
    "toolset-state:pi-lean-dimension.web": { "enabled": false },
    "toolset-state:pi-lean-dimension.web-learn": { "enabled": false },
    "toolset-state:pi-lean-dimension.search": { "enabled": false },
    "toolset-state:pi-lean-dimension.api": { "enabled": false },
    "toolset-state:pi-lean-dimension.api-learn": { "enabled": false }
  }
}
```

`toolsetDefaults` is read by the [`pi-tool-masking`](https://github.com/coreyryanhanson/pi-tool-masking/) library on restore, before
the toolset's packaged default. Omit a key to use the packaged default; the
`search` keys only apply when `pi-lean-search` is installed, and the `api` /
`api-learn` keys only apply when `pi-lean-host` is installed.

> The legacy `browserToggle.defaultEnabled` key is **removed in 0.4.0** and
> no longer read. If you pinned it, move the value into the matching
> `toolsetDefaults` entry above.

---

## Install options

| Mode | Command | What you get | Requires |
|---|---|---|---|
| **A — Browser + API** (recommended) | `pi install npm:pi-lean-portal` + `npm:pi-lean-host` | 17 tools (12 browser + 5 API) + `/web` + `/api` + co-install projection | `npx playwright install chromium firefox` |
| **B — Full suite** | `pi install npm:pi-lean-dimension` | 18 tools (browser + search + API) + `/web` + `/api` | Playwright browsers + SearXNG server |
| **C — Browser only** | `pi install npm:pi-lean-portal` | 12 browser tools + `/web` command | `npx playwright install chromium firefox` |
| **D — Host only (API)** | `pi install npm:pi-lean-host` | 5 API tools + `/api` command | none |
| **E — Search only** | `pi install npm:pi-lean-search` | `web-search` tool only | SearXNG server |

Notes the table doesn't cover:

- **Browser binaries aren't downloaded during `npm install`** (configured via `.npmrc`). The first `browser-navigate` call prompts you to run `npx playwright install chromium firefox` if they're missing.
- **SearXNG is optional for Mode B.** The browser works immediately without it; `web-search` returns a clear setup message on first call. When you do run it, point the suite at your instance in Pi settings:

  ```json
  { "searxng": { "url": "http://localhost:8888" } }
  ```

- **Search-only has no `/web` or `/api` command** — a single tiny tool has nothing to toggle.

---

## What's included

### Packages

| Package | Type | Description |
|---|---|---|
| `pi-lean-portal` | Extension | Interactive browser + `/web` command owner. **12 tools + 1 command.** |
| `pi-lean-search` | Extension | SearXNG search tool (`web-search`). **1 tool + 1 command** (`/searxng-status`). |
| `pi-lean-host` | Extension | Declarative HTTP API client (`api-guide`, `api-fetch`, `api-learn`, `api-probe`, `api-scaffold`). **5 tools + 1 command** (`/api`). |
| `pi-lean-dimension` | Umbrella meta-package | Bundles portal + search + host for one-command install. |

### Tools (18 total with search + host)

| Tool | Package | Purpose |
|---|---|---|
| `browser-navigate` | portal | Navigate to a URL, get an accessibility tree with `@e` element refs |
| `browser-snapshot` | portal | Re-extract the current page's accessibility tree (`@e` refs) and capture a screenshot to a temp file |
| `browser-click` | portal | Click an element by `@e` ref |
| `browser-type` | portal | Type text into an input by `@e` ref |
| `browser-scroll` | portal | Scroll the page |
| `browser-back` | portal | Navigate back |
| `browser-press` | portal | Press a key |
| `browser-console` | portal | Read console messages from the page |
| `browser-inspect` | portal | Query and extract text from elements |
| `web-fetch` | portal | Stateless fetch → Markdown (no JS) |
| `web-guide` | portal | Navigation guidance for a site or pattern |
| `web-learn` | portal | Save/update navigation guidance |
| `web-search` | search | Web search via SearXNG |
| `api-guide` | host | Browse or inspect API guides |
| `api-fetch` | host | Execute an API operation from a guide |
| `api-learn` | host | Write or update an API guide |
| `api-probe` | host | Discover an endpoint's shape and draft a recipe operation block |
| `api-scaffold` | host | Bootstrap starter `verify.json` / `helper.ts` files (local write) |

### Commands

| Command | Owner | Description |
|---|---|---|
| `/web on\|off\|learn\|cookies\|profile\|status` | portal | Unified toggle and management |
| `/searxng-status` | search | Test SearXNG connection and update status glyph |
| `/api on\|off\|learn\|status\|helpers\|secrets\|verify\|delete` | host | Independent API tools toggle, guide verification, secrets, and management |

### Status bar

When host is installed alongside portal and search, three independent glyphs appear:

- `● idle` (browser) — browser tools enabled
- `● searxng` (search) — SearXNG health (accent=healthy, yellow=degraded, red=unreachable)
- `● api` (host) — API tools enabled (accent=on, success=learn, ○=off)

---

## Extending it

Beyond the toggles, three surfaces are user-driven rather than hardcoded:

- **Navigation guides** — `web-learn` saves site-specific playbooks that auto-match by domain and resurface in later sessions.
- **API recipes** — `api-learn` authors site-specific recipe guides (endpoints, auth, pagination, response shape) that `api-fetch` executes. For a head start, the [**caritas**](https://github.com/coreyryanhanson/caritas) repo maintains a library of prebuilt, verified recipes (arxiv, github, wikidata, coingecko, and more) — copy any one into `~/.pi/agent/pi-lean-host/api-guides/` and it loads immediately. Recipes are inert until you copy them, and the primary path is still having your agent author guides on demand via `/api learn`. See the [host README](packages/pi-lean-host/README.md#bundled-reference-recipes) for the full flow.
- **Custom browser backends** — if a site blocks the shipped Chromium/Firefox, drop a `bridge.py` subclass into `~/.pi/agent/pi-lean-portal/user-backends/` and drive a patched engine like [Camoufox](https://github.com/daijro/camoufox) yourself. A quirks schema declares how the engine diverges from base Playwright, and `launch` options flow from `settings.json` to the subprocess at runtime. This is user-authored, user-audited code that the extension never auto-downloads. Most installs never need it; the [portal README](packages/pi-lean-portal/README.md#stealth--custom-browser-backends) and [`contributed/README.md`](packages/pi-lean-portal/contributed/README.md) cover the full flow when you do.

---

## Development

```bash
git clone https://github.com/coreyryanhanson/pi-lean-dimension.git
cd pi-lean-dimension
npm install
npm test                    # vitest run — all workspace tests
```

## License

AGPL-3.0-only
