# Web Navigation Guides for pi-browser

> Date: 2026-06-12
> Status: **Proposed** — on-demand site-specific guidance delivered via a single tool,
> with automatic discovery through domain-based auto-hinting.
>
> This proposal supersedes `custom_web.md` and incorporates oracle review findings
> from `oracle-custom-web.md` and subsequent oracle analysis.

---

## 1. Problem

Every time the agent visits a site it hasn't learned, it wastes 5–8 tool calls
reverse-engineering the page structure: which @e refs are clickable, which
dialog to dismiss, where the content actually lives. Repeated visits repeat
the same discovery cost. The system has no way to **accumulate and reuse**
site-specific navigation knowledge.

The core browser tools (`browser-navigate`, `browser-click`, `browser-type`)
are correct as a **foundation layer**, but they force every agent to reason
at the level of individual interactions. An advisory layer is needed so the
agent can consult accumulated knowledge without replacing its own reasoning.

---

## 2. Design Decisions

### 2.1 Why On-Demand, Not System-Prompt Injection

The original proposal (`custom_web.md`) used `promptGuidelines` to inject
navigation knowledge into the system prompt. Oracle review identified two
fatal problems with this approach:

1. **Linear token scaling** — each active skill costs ~400–650 tokens
   **every turn**, including turns interacting with unrelated sites. Five
   active skills cost ~2000–3200 tokens/turn regardless of which site the
   agent is currently on.

2. **Per-site toggles are a false economy** — toggling skills on/off controls
   system-prompt injection, but with on-demand retrieval, guidance isn't in
   the system prompt at all. The toggle solves a problem that no longer exists.

**This proposal replaces system-prompt injection with on-demand retrieval.**
A single `web-guide` tool returns markdown guidance when explicitly called.
Guidance enters context once, not every turn.

### 2.2 Why Not Pre-Baked Method Sequences

An oracle-reviewed alternative proposed site-specific tools with their own
methods (`web-reddit.dismiss-consent()`, `web-reddit.scroll-feed()`). This
was rejected because:

- Pre-baked sequences are **brittle macros** — they break harder than guidance
  text when sites change, and they break silently within method execution.
- They introduce **session-state coupling** — internal `browser-snapshot`
  followed by `browser-click` can have stale @e refs within a single call.
- They create **error-handling complexity** — agent must understand two error
  formats (base tools + method wrappers) with opaque failure modes.
- They **don't actually reduce tool calls** — they just hide them inside
  method implementations.

### 2.3 Why Not Auto-Inject Full Guides

Another oracle-reviewed alternative proposed automatically injecting full
guidance into `browser-navigate` results based on domain detection. This was
rejected because:

- **Stale auto-injected guidance is dangerous** — the agent treats system
  output as authoritative. Stale guidance from a forced injection is more
  harmful than stale guidance the agent opted into.
- **Redundant injection on revisits** — every `browser-navigate` to the same
  domain re-injects the guide, even if the agent already consumed it.
- **URL edge cases are complex** — subdomains (`old.reddit.com`), `www.`
  prefixes, redirects, and URL shorteners all require fallback chain logic.
- **Agent-generated guides are aspirational** — single-visit exploration
  produces low-quality guidance; the "build a guide" flow is deferred.

### 2.4 What We Do Instead: On-Demand + Auto-Hint Discovery

The winning approach combines the best elements:

| Property | Mechanism |
|----------|-----------|
| **Guidance delivery** | Single `web-guide` tool returns markdown on demand |
| **Discovery** | Domain-to-site mapping auto-appends a one-line hint to navigate results |
| **Token cost** | Tool schema (~100–150 tokens/turn) + guide content (one-time, ~300–500 tokens) |
| **Authority** | Agent opts in to guidance; can discount stale content against actual page state |

---

## 3. The `web-guide` Tool

### 3.1 Guide Content Structure

Guides are stored as typed entries with content and freshness metadata:

```typescript
interface Guide {
  content: string;   // markdown guidance text
  updated: string;   // ISO date of last update
}

const SKILL_CONTENT: Record<string, Guide> = {
  "cookie-consent": {
    updated: "2026-06-12",
    content: `## Cookie Consent Patterns
...`,
  },
  "pagination": {
    updated: "2026-06-12",
    content: `## Pagination Patterns
...`,
  },
  "search": {
    updated: "2026-06-12",
    content: `## Search Patterns
...`,
  },
  "reddit": {
    updated: "2026-06-01",
    content: `## Reddit Navigation Patterns
...`,
  },
  "github": {
    updated: "2026-06-01",
    content: `## GitHub Navigation Patterns
...`,
  },
};
```

### 3.2 Tool Definition

```typescript
const webGuideTool = defineTool({
  name: "web-guide",
  label: "Web Navigation Guide",
  description:
    "Get site-specific navigation guidance. " +
    "Call with a site name (e.g. 'reddit', 'github') for guidance, " +
    "or with no site parameter to list all available guides.",
  parameters: Type.Object({
    site: Type.Optional(
      Type.String({
        description: "Site name (e.g. 'reddit', 'github'). Omit to list all guides.",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const { site } = params as { site?: string };
    if (!site) {
      return {
        content: [{ type: "text", text: formatGuideList(SKILL_CONTENT) }],
      };
    }
    const guide = SKILL_CONTENT[site];
    if (!guide) {
      return {
        content: [{
          type: "text",
          text: `No guide for '${site}'. Available: ${Object.keys(SKILL_CONTENT).join(", ")}`,
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: guide.content + `\n\n_Updated: ${guide.updated}_`,
      }],
    };
  },
});
```

### 3.3 Token Cost Analysis

| Scenario | Token Cost |
|----------|-----------|
| `web-guide` tool schema (per turn, always) | ~100–150 |
| Guide content (one-time, when called) | ~300–500 |
| Auto-hint in navigate result (when applicable) | ~20 |
| **First visit to a site with guide** | ~520–670 (schema + hint + guide) |
| **Subsequent visits** | ~100–150 (schema only; agent remembers) |
| **No guide for site** | ~100–150 (schema only) |

**Compared to skill-tools approach:**
- 3 active skills, 10 turns: skill-tools = ~12,000–19,500 tokens; this proposal = ~1,500–3,000
- The guide content enters context **once** rather than **every turn**

---

## 4. Auto-Hint Discovery

### 4.1 The Problem

The agent must discover that guidance exists. Without auto-hint, this requires
the agent to notice `web-guide` in its tool list and make the connection to
the current site. LLMs sometimes make this connection, sometimes don't.

### 4.2 The Solution

When the agent navigates to a URL, a **one-line hint** is appended to the
navigate result if a guide exists for that domain.

```
💡 A web guide is available for reddit.com.
   Call web-guide site="reddit" for navigation tips.
```

The hint is ~20 tokens. Full guidance is ~500 tokens. Discovery is automatic;
consumption is opt-in.

### 4.3 Domain-to-Site Mapping

A simple hostname-to-site-name mapping handles discovery, `www.` normalization,
and subdomain variants:

```typescript
const DOMAIN_MAP: Record<string, string> = {
  "reddit.com": "reddit",
  "www.reddit.com": "reddit",
  "old.reddit.com": "reddit",
  "github.com": "github",
  "hackernews.com": "hackernews",
  "news.ycombinator.com": "hackernews",
  "www.hackernews.com": "hackernews",
  "theguardian.com": "guardian",
  "www.theguardian.com": "guardian",
};
```

This mapping is loaded once at startup and cached in memory. Lookup on every
`browser-navigate` is a simple `new URL(url).hostname` + dict check.

### 4.4 Hint Injection in Navigate Output

The hint is injected in the `browser-navigate` tool's output (in `index.ts`),
**not** in the router. This keeps the router pure and couples hint logic only
to the navigate tool:

```typescript
// In index.ts, browser-navigate tool's execute()
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const result = await router.navigate(params.url, taskId, strategy);

  const hint = resolveDomainHint(params.url, DOMAIN_MAP, SKILL_CONTENT);
  if (hint) {
    // Append hint to the rendered navigate output
    output = renderNavigateResult(result) + "\n" + hint;
  }
  return { content: [{ type: "text", text: output }] };
}
```

The `resolveDomainHint` function:
1. Extracts hostname from URL
2. Looks up site name in `DOMAIN_MAP`
3. Checks if a guide exists in `SKILL_CONTENT` for that site name
4. If both match, returns the one-line hint; otherwise returns undefined

---

## 5. Agent-Controlled Truncation (`maxChars`)

*Independent change — proceeds regardless of guide implementation.*

Add `maxChars` to `browser-navigate` and `browser-snapshot`:

```
1. browser-navigate "reddit.com", maxChars=500  → quick scan: what am I looking at?
2. browser-snapshot, maxChars=2000               → deeper: inspect the dialog
3. browser-snapshot, maxChars=0                  → full tree for complex interaction
```

Guides can guide the agent's truncation choices:

```
"Start with maxChars=1000 to check for the consent dialog.
If it's gone, scan the feed with maxChars=0."
```

### 5.1 Parameter Design

```typescript
maxChars: Type.Optional(
  Type.Number({
    description:
      "Maximum snapshot characters. " +
      "Default: auto (compact ~2500 chars). " +
      "Use 500–1000 for quick scans. " +
      "Use 0 for full snapshot.",
    minimum: 0,
    maximum: 50000,
  }),
),
```

### 5.2 Router Integration

`compactSnapshot` accepts the optional `maxChars`:

```typescript
export function compactSnapshot(
  snapshot: string,
  elementCount: number,
  maxChars?: number,
): string {
  // No truncation
  if (maxChars === 0) return snapshot;

  // Agent requested specific truncation
  if (maxChars !== undefined) {
    const cut = snapshot.lastIndexOf("\n", maxChars);
    const actualCut = cut < maxChars / 2 ? maxChars : cut;
    const tail = elementCount
      ? `\n… ${snapshot.length - actualCut} more chars, ${elementCount} elements total`
      : `\n… ${snapshot.length - actualCut} more chars`;
    return snapshot.slice(0, actualCut) + tail;
  }

  // Auto mode (existing behavior)
  // ...
}
```

### 5.3 `maxChars=0` Convention

Oracle review flagged that `maxChars=0` is ambiguous (0 usually means "none").
The parameter description explicitly states "Use 0 for full snapshot" and
guides reference this convention. If this proves confusing in practice,
the alternative is a boolean `full: true` parameter. Deferred decision —
start with `maxChars=0` and revisit if agents struggle with it.

---

## 6. Why There Are No Categories or Toggles

The original proposal (`custom_web.md`) included categories and per-site
on/off toggles. Both were solving problems that no longer exist with
auto-hint discovery:

- **Discovery** — auto-hint tells the agent a guide exists when it
  navigates to that domain. The agent never needs to browse a catalog.
- **Project scoping** — guidance costs zero tokens when not visited.
  Having a shopping guide in `SKILL_CONTENT` while working on a dev
  project costs nothing — the hint only fires on matching domains.
- **Per-site toggles** — guidance isn't in the system prompt, so there
  is nothing to toggle off. The agent calls `web-guide` when it needs
  guidance, and the auto-hint tells it when that's available.

The `Guide` interface is deliberately minimal:

```typescript
interface Guide {
  content: string;   // markdown guidance text
  updated: string;   // ISO date of last update
}
```

No category, no enabled/disabled, no per-site metadata.

**What if you want a list of available guides?** Calling `web-guide` with
no site parameter returns a flat list of all guide names with their
`updated` dates. For 50 guides, that's ~200 tokens, shown once, then
forgotten. If that proves unwieldy in practice, categories can be
reintroduced as a display concern — not as a filtering mechanism.

---

## 7. What Does NOT Change

These existing layers are foundational and remain untouched. This explicitly
contradicts Section 8 of `custom_web.md`, which proposed simplifying them
as a consequence of implementing skills. Oracle review confirmed this is
a **false dependency** — guides provide knowledge, these layers provide
runtime safety. They coexist cleanly.

| Layer | Why It Stays |
|-------|-------------|
| `extractDialogBlocks()` | Handles dialog visibility in truncated snapshots. Orthogonal to guides. |
| Snapshot fingerprint warnings | Catch SPA transitions guides can't predict (dynamic content, infinite scroll, mutation-based UIs). |
| `browser_finetuning.md` | Institutional knowledge about occlusion/dialog methodology. Future maintainers need the rationale. |
| `checkOcclusion()` | Runtime occlusion detection via `elementFromPoint`. Guides can say "watch out" but can't replace the check. |
| `verifyClick` fallback | Runtime safety net for false-positive occlusion. |
| `url-safety.ts` | SSRF, secret, scheme validation. Security boundary. Never knowledge-driven. |
| `bot-detection.ts` | Heuristic Cloudflare/CAPTCHA detection. Guides supplement, don't replace. |
| `plan_v2.md` | Authoritative architecture rationale. Archive only when architecture is stable (v3+). |

---

## 8. Implementation Steps

1. **Add `maxChars` parameter** to `browser-navigate` and `browser-snapshot` in
   `index.ts`, wire into `compactSnapshot()` in `router.ts` (~40 lines)
2. **Define `web-guide` tool** in `index.ts` with `site` parameter and guide
   content map (~60 lines)
3. **Add `DOMAIN_MAP`** with hostname-to-site-name resolution (~30 lines)
4. **Add auto-hint injection** into `browser-navigate` tool output (~15 lines)
5. **Start with 3 cross-cutting guides** (cookie-consent, pagination, search)
   and 2 site-specific guides (reddit, github)
6. **Update `AGENTS.md`** — document web-guide tool and auto-hint pattern

**Total new code: ~150 lines.** No changes to router core, plugin system,
session management, or existing safety nets.

---

## 9. Deferred

| Feature | Reason |
|---------|--------|
| **Agent-generated guides ("build a guide")** | Single-visit exploration produces low-quality guides. Requires real-time user interaction, breaks async model, introduces filesystem trust boundaries. |
| **Per-site toggles** | Guidance isn't in the system prompt — there's nothing to toggle off. Categories provide project-scoped discovery filtering. |
| **User-authored guides directory** | Start with guides in code. Externalize to `~/.pi/agent/skills/pi-browser/` after proving value with hand-authored content. |
| **Guide freshness monitoring** | Display staleness warnings when `updated` is older than threshold. Add when users encounter stale guides. |
| **Domain-aware conditional injection** | When pi supports `registerSkill` API, migrate from guide-tool to real skills with conditional context. |
| **Cross-cutting guide auto-applying** | Cross-cutting guides (cookie-consent, pagination) could auto-apply as `promptGuidelines` since they're site-agnostic. Deferred until after site-specific guides prove their value. |

---

## 10. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Stale guide content** | Medium | Guides carry `updated` date; agent can cross-reference with actual page state; stale guides are advisory, not authoritative |
| **Agent ignores auto-hint** | Low | Worst case = same as today (discovery cost). Agent can still call `web-guide` manually |
| **Guide content accumulates in conversation** | Low | Guides are ~300–500 chars; small compared to snapshot output (~2500 chars) |
| **Domain mapping needs updates for variants** | Low | Simple JSON object; add entries as needed; missing subdomains fall back to no-hint |
| **Tool schema adds ~100–150 tokens/turn** | Low | Fixed cost paid once; savings on first-visit discovery (5–8 tool calls → 1–2) far exceed overhead |
| **`maxChars=0` convention is confusing** | Low | Parameter description explicitly states meaning; can switch to `full: true` boolean if agents struggle |

---

## 11. Appendix: Example Guide Content

### cookie-consent (cross-cutting)

```markdown
## Cookie Consent Patterns

### Common Dialog Indicators
- role="dialog" or role="alertdialog" at the top of the accessibility tree
- Buttons containing "Accept All", "Reject All", "Decline", "Manage"
- Pressing Escape dismisses many consent dialog variants

### Navigation After Dismissal
- After dismissing consent, take a fresh snapshot — @e refs from before
  dismissal are stale
- Some sites reload; others hide the dialog client-side. Either way,
  re-scan before interacting with page content
```

### pagination (cross-cutting)

```markdown
## Pagination Patterns

### Common Patterns
- "Next" or "→" button is role="button" or role="link"
- Page numbers may be role="list" with role="listitem" per page
- Infinite scroll: use browser-scroll to load more content
- After scrolling, take a fresh snapshot — new elements may appear

### Progressive Loading
- Use maxChars=500 for initial scan, then maxChars=0 after confirming
  content loaded
- After scrolling, wait briefly before taking snapshot (content may
  still be loading)
```

### search (cross-cutting)

```markdown
## Search Patterns

### Common Patterns
- Search bar is role="searchbox" or role="combobox"
- Keyboard shortcut "/" focuses search on many sites (use browser-press)
- Results may load in-page (SPA) or via navigation

### After Searching
- Take a fresh snapshot after typing or submitting
- Results are often role="list" with role="listitem" per result
- Pagination controls follow the patterns in the pagination guide
```

### reddit (site-specific)

```markdown
## Reddit Navigation Patterns

### Consent Dialog (First Visit)
Reddit shows a data consent dialog (role="dialog").
- Look for a button containing "Reject All" or "Decline"
- Pressing Escape also dismisses some variants
- After dismissing, a second "welcome" dialog may appear

### Feed
- Main feed uses role="table" or role="list"
- Post titles are role="link" or role="rowheader"
- Use browser-scroll to load more content

### Search
- Search bar is role="combobox" with name "Search"
- Results load in-page (SPA navigation)
- Take a fresh snapshot after typing
```

### github (site-specific)

```markdown
## GitHub Navigation Patterns

### Repo Page
- File list is role="table"; filenames are role="link" or role="cell"
- Navigation tabs (Code, Issues, Pull requests) are role="tab"

### Pull Requests
- PR list uses role="list" with role="listitem" per PR
- "Files changed" tab shows diffs

### Search
- Global search is role="combobox" at the top
- Keyboard shortcut "/" focuses the search box
- Results page uses role="list"

### Known Quirks
- No consent dialogs
- GitHub uses client-side routing — take a fresh snapshot after clicking links;
  @e refs from the previous page are stale
```
