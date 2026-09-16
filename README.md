# pi-lean-dimension

> Web browsing, search, and API tools for [Pi](https://github.com/earendil-works/pi), the AI coding agent.

A monorepo of three Pi extensions that let your AI agent
browse the web interactively, fetch static pages as Markdown, search
via SearXNG, and call REST APIs through declarative recipe guides. Each surface
has its own toggle (/web for browser tools, /api for API tools), so the ones
you aren't using are removed from the agent's context entirely and
don't consume tokens or attention. Search is an optional add-on if you run a
SearXNG instance.

## Quick start (recommended)

```bash
pi install npm:pi-lean-portal
pi install npm:pi-lean-host
```

then, inside pi, run **`/web install`** once to download the Chromium/Firefox
browser binaries.

Once installed, the core browsing and API tools are enabled by default; the guide-authoring tools stay off until you opt in (see Commands
below). To set a different default for **new** sessions, add a
`toolsetDefaults` block to your Pi settings (`~/.pi/agent/settings.json` or
`.pi/settings.json`). The key pattern is the same for every toggle:

```json
{
  "toolsetDefaults": {
    "toolset-state:pi-lean-dimension.web": { "enabled": false },
    "toolset-state:pi-lean-dimension.api": { "enabled": false }
  }
}
```

`toolsetDefaults` is read by the [`pi-tool-masking`](https://github.com/coreyryanhanson/pi-tool-masking/) library on restore,
before the toolset's packaged default. Omit a key to use the packaged default;
keys only apply when their package (`pi-lean-search` for search, `pi-lean-host`
for api) is installed.

---

## Packages & install

The Quick start above shows a common mix (portal + host). Install any combination from the table below, or the full suite via `pi install npm:pi-lean-dimension` ([^1], [^2]).

| Package | What you get | Requires |
|---|---|---|
| [`pi-lean-portal`](https://github.com/coreyryanhanson/pi-lean-dimension/tree/main/packages/pi-lean-portal) | Interactive browser tools + `/web` command | Playwright browser packages[^1] |
| [`pi-lean-host`](https://github.com/coreyryanhanson/pi-lean-dimension/tree/main/packages/pi-lean-host) | Declarative API tools + `/api` command | none |
| [`pi-lean-search`](https://github.com/coreyryanhanson/pi-lean-dimension/tree/main/packages/pi-lean-search) | `web-search` + `/searxng-status` | a SearXNG server[^2] |

[^1]: **Browser binaries aren't downloaded during `npm install`.** Run `/web install` inside pi to fetch them (or `/web install chromium|firefox` for a single engine). If you'd rather download manually, run the bundled-CLI command `/web install` prints — a bare `npx playwright install chromium firefox` may resolve a different playwright copy and install revisions the backends don't match.
[^2]: **SearXNG is only required by `pi-lean-search`.** The browser works immediately without it; `web-search` returns a clear setup message on first call. When you do run it, point the suite at your instance in Pi settings with `{ "searxng": { "url": "http://localhost:8888" } }`.

### Tools

#### Portal

| Tool | Purpose |
|---|---|
| `browser-navigate` | Navigate to a URL, get an accessibility tree with `@e` element refs |
| `browser-snapshot` | Re-extract the current page's accessibility tree (`@e` refs) and capture a screenshot to a temp file |
| `browser-click` | Click an element by `@e` ref |
| `browser-type` | Type text into an input by `@e` ref |
| `browser-scroll` | Scroll the page |
| `browser-back` | Navigate back |
| `browser-press` | Press a key |
| `browser-console` | Read console messages from the page |
| `browser-inspect` | Query and extract text from elements |
| `web-fetch` | Stateless fetch → Markdown (no JS) |
| `web-guide` | Navigation guidance for a site or pattern |
| `web-learn` | Save/update navigation guidance |

#### Search

| Tool | Purpose |
|---|---|
| `web-search` | Web search via SearXNG |

#### Host

| Tool | Purpose |
|---|---|
| `api-guide` | Browse or inspect API guides |
| `api-fetch` | Execute an API operation from a guide |
| `api-learn` | Write or update an API guide |
| `api-probe` | Discover an endpoint's shape and draft a recipe operation block |
| `api-scaffold` | Bootstrap starter `verify.json` / `helper.ts` files (local write) |
| `api-store` | Read-only inspection of the secrets + token-slot stores (learn-gated) |
| `oauth-mint` | Human-in-the-loop OAuth2 token mint |

### Commands

| Command | Owner | Description |
|---|---|---|
| `/web on\|off\|learn\|install\|cookies\|profile\|status` | portal | Unified toggle, browser-binary install, and management |
| `/searxng-status` | search | Test SearXNG connection and update status glyph |
| `/api on\|off\|learn\|status\|helpers\|secrets\|verify\|delete\|oauth\|bootstrap` | host | Independent API tools toggle, guide verification, secrets, management, OAuth2 token mint/status, and agent-driven OAuth2 bootstrap |

### Status bar

Each installed package contributes one independent status-bar glyph:

- `● idle` (browser) — browser tools enabled
- `● searxng` (search) — SearXNG health (accent=healthy, yellow=degraded, red=unreachable)
- `● api` (host) — API tools enabled (accent=on, success=learn, ○=off)

---

## Extending it

Beyond the toggles, three surfaces are user-driven rather than hardcoded:

- **Navigation guides** — `web-learn` saves site-specific playbooks that auto-match by domain and resurface in later sessions.
- **API recipes** — `api-learn` authors site-specific recipe guides (endpoints, auth, pagination, response shape) that `api-fetch` executes. For a head start, the [**caritas**](https://github.com/coreyryanhanson/caritas) repo maintains a library of prebuilt, verified recipes (arxiv, github, wikidata, coingecko, and more) — copy any one into `~/.pi/agent/pi-lean-host/api-guides/` and it loads immediately. Recipes are inert until you copy them, and the primary path is still having your agent author guides on demand via `/api learn`. See the [host README](https://github.com/coreyryanhanson/pi-lean-dimension/blob/main/packages/pi-lean-host/README.md#bundled-reference-recipes) for the full flow.
- **Custom browser backends** — if a site blocks the shipped Chromium/Firefox, drop a `bridge.py` subclass into `~/.pi/agent/pi-lean-portal/user-backends/` and drive a patched engine like [Camoufox](https://github.com/daijro/camoufox) yourself. A quirks schema declares how the engine diverges from base Playwright, and `launch` options flow from `settings.json` to the subprocess at runtime. This is user-authored, user-audited code that the extension never auto-downloads. Most installs never need it; the [portal README](https://github.com/coreyryanhanson/pi-lean-dimension/blob/main/packages/pi-lean-portal/README.md#stealth--custom-browser-backends) and [`contributed/README.md`](https://github.com/coreyryanhanson/pi-lean-dimension/blob/main/packages/pi-lean-portal/contributed/README.md) cover the full flow when you do.

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
