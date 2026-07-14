# pi-lean-search

> SearXNG search tool for Pi. Part of the [pi-lean-dimension](https://github.com/coreyryanhanson/pi-lean-dimension) web-tools suite.

## Quick start

```bash
pi install npm:pi-lean-portal   # recommended: browser + /web toggle
pi install npm:pi-lean-search   # adds web-search to /web on|off
```

Or get the full suite in one command:

```bash
pi install npm:pi-lean-dimension # portal + search, requires SearXNG server
```

## Usage

| Command / Tool | Description |
|---|---|
| `web-search` tool | Search the web via your SearXNG instance. Supports `count` (1–100) and `pageno` (1-indexed) for deeper result pagination. Agents use this automatically. |
| `/searxng-status` | Test and diagnose the SearXNG connection. |

The `web-search` tool is automatically included in `/web on` / `/web off` toggling
when `pi-lean-portal` is also installed. The status bar shows a `● searxng` glyph
(colored accent/blue when healthy, yellow when degraded, red when unreachable).

## Configuration

Set the URL of your SearXNG instance in your Pi settings file:

**`~/.pi/agent/settings.json`** (global) or **`.pi/settings.json`** (project-local):

```json
{
  "searxng": {
    "url": "http://localhost:8888"
  }
}
```

- **Self-hosted SearXNG:** Run your own instance ([docs](https://docs.searxng.org/)).
- No URL configured? The tool returns a setup message on its first call — no errors, no broken prompts.

## Graceful degradation

If SearXNG is unreachable or unconfigured, the `web-search` tool returns a clear
message pointing you toward setup instructions. It never throws or breaks the agent.

## Tests

```bash
npx vitest run packages/pi-lean-search/
```
