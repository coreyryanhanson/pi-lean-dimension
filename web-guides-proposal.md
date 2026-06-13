# Web Navigation Guides for pi-browser

> Date: 2026-06-13
> Updated: added guide categories (site/pattern) with trigger-based presence tiers
> (auto-inject, auto-hint, on-demand), session-level inject suppression with
> downgrade to hint, `autoInject` config toggle, `dialogPresent` trigger for
> cookie-consent, and category-aware guide listing.
> Reconciled with Phase 1 (snapshot disk cache), Phase 2 (browser-inspect),
> and Phase 3 (hint text refresh) — all now implemented.
> Status: **Accepted** — on-demand site-specific guidance via `web-guide` tool,
> with automatic discovery through domain-based auto-hinting and condition-triggered
> auto-injection.

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

## 2. Approach: On-Demand Guides + Auto-Hint Discovery

| Property | Mechanism |
|----------|-----------|
| **Guidance delivery** | Single `web-guide` tool returns markdown on demand |
| **Discovery** | Domain-to-site mapping auto-appends a one-line hint; pattern guides can auto-inject or auto-hint based on runtime triggers |
| **Token cost** | Tool schema (~100–150 tokens/turn) + guide content (one-time, ~300–600 tokens) |
| **Authority** | Agent opts in to guidance; can discount stale content against actual page state |
| **Presence tiers** | Auto-inject (full content, for stuck agents), auto-hint (20-token nudge), on-demand (agent calls `web-guide`) |

**Key design principle: guidance enters context once, not every turn.** For
auto-injected guides, this means session-level suppression: the first trigger
injects the full content, subsequent triggers downgrade to a hint.

Guides recommend the cheapest effective tool for each task — preferring
`browser-inspect` for targeted element discovery and text extraction over
full `browser-snapshot` loads, and referencing the snapshot disk cache when
the agent needs to see all elements on a large page. This aligns with the
existing hint text that the router appends to truncated snapshots.

---

## 3. The `web-guide` Tool

### 3.1 Guide Content Structure

Guides are stored as typed entries with content and freshness metadata:

```typescript
type GuideCategory = "site" | "pattern";

/** Trigger that promotes a pattern guide to auto-presence. */
interface GuideTrigger {
  /** Which navigate-result signal to check. */
  signal: "botDetected" | "dialogPresent";
  /** How to surface the guide when the signal fires. */
  presence: "inject" | "hint";
}

interface Guide {
  content: string;         // markdown guidance text, max ~600 tokens / ~800 chars
  updated: string;         // ISO date of last update
  category: GuideCategory; // site = domain-mapped, pattern = cross-cutting
  staleAfterDays?: number; // optional: emit staleness warning beyond this threshold
  trigger?: GuideTrigger;  // only pattern guides use this; site guides use DOMAIN_MAP
}

const GUIDE_CONTENT: Record<string, Guide> = {
  // Site guides — discovered via DOMAIN_MAP auto-hint
  "reddit": {
    category: "site",
    updated: "2026-06-01",
    content: `## Reddit Navigation Patterns
...`,
  },
  "github": {
    category: "site",
    updated: "2026-06-01",
    content: `## GitHub Navigation Patterns
...`,
  },
  // Pattern guides — discovered via trigger or on-demand
  "bot-detection": {
    category: "pattern",
    updated: "2026-06-13",
    trigger: { signal: "botDetected", presence: "inject" },
    content: `## Bot Detection Patterns
...`,
  },
  "cookie-consent": {
    category: "pattern",
    updated: "2026-06-12",
    trigger: { signal: "dialogPresent", presence: "hint" },
    content: `## Cookie Consent Patterns
...`,
  },
  "pagination": {
    category: "pattern",
    updated: "2026-06-12",
    content: `## Pagination Patterns
...`,
  },
  "search": {
    category: "pattern",
    updated: "2026-06-12",
    content: `## Search Patterns
...`,
  },
};
```

The `Guide` interface is deliberately minimal beyond the essential fields.
The `category` field drives both listing organization and auto-presence
behavior. The `trigger` field is only used by pattern guides — site guides
discover via `DOMAIN_MAP` instead.

Calling `web-guide` with no `guide` parameter returns a categorized list of
all guide names with their `updated` dates and trigger descriptions
(~200 tokens for 50 guides, shown once, then forgotten).

**Content size cap:** Guides should be ≤600 tokens / ~800 chars. If a guide
exceeds this, split it into multiple focused guides or trim content. The tool
does not enforce truncation at runtime — this is an authoring discipline.
A guide that's too long costs more than the discovery it saves.

### 3.2 Tool Definition

```typescript
const webGuideTool = defineTool({
  name: "web-guide",
  label: "Web Navigation Guide",
  description:
    "Get navigation guidance for a site or pattern. " +
    "Call with a guide name (e.g. 'reddit', 'cookie-consent', 'bot-detection') " +
    "for guidance, or with no parameter to list all available guides.",
  parameters: Type.Object({
    guide: Type.Optional(
      Type.String({
        description: "Guide name (e.g. 'reddit', 'cookie-consent', 'bot-detection'). Omit to list all guides.",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const { guide } = params as { guide?: string };
    if (!guide) {
      return {
        content: [{ type: "text", text: formatGuideList(GUIDE_CONTENT) }],
      };
    }
    const entry = GUIDE_CONTENT[guide];
    if (!entry) {
      return {
        content: [{
          type: "text",
          text: `No guide for '${guide}'. Available: ${Object.keys(GUIDE_CONTENT).join(", ")}`,
        }],
      };
    }
    let text = entry.content + `\n\n_Updated: ${entry.updated}_`;
    // Staleness warning if configured
    if (entry.staleAfterDays) {
      const ageDays = (Date.now() - new Date(entry.updated).getTime()) / 86400000;
      if (ageDays > entry.staleAfterDays) {
        text += `\n\n⚠️ This guide was last updated ${Math.round(ageDays)} days ago. ` +
          `Verify recommendations against the current page state.`;
      }
    }
    return {
      content: [{ type: "text", text }],
    };
  },
});

/** Format guide listing grouped by category. */
function formatGuideList(guides: Record<string, Guide>): string {
  const sites = Object.entries(guides)
    .filter(([, g]) => g.category === "site")
    .map(([name, g]) => `  ${name} (updated ${g.updated})`);
  const patterns = Object.entries(guides)
    .filter(([, g]) => g.category === "pattern")
    .map(([name, g]) => {
      const trigger = g.trigger
        ? ` — auto-${g.trigger.presence} when ${g.trigger.signal}`
        : "";
      return `  ${name} (updated ${g.updated})${trigger}`;
    });
  return [
    "Available guides:\n",
    "Site guides:",
    ...sites,
    "",
    "Pattern guides:",
    ...patterns,
    "",
    'Call web-guide guide="<name>" for guidance.',
  ].join("\n");
}
```

### 3.3 Token Cost Analysis

| Scenario | Token Cost |
|----------|-----------|
| `web-guide` tool schema (per turn, always) | ~100–150 |
| Guide content (one-time, when called or injected) | ~300–600 |
| Auto-hint in navigate result (site-specific or dialog trigger) | ~20 |
| Auto-inject in navigate result (bot-detection, first time only) | ~300–600 |
| **First visit to a site with guide** | ~520–670 (schema + hint + guide) |
| **Bot-detected page (first time)** | ~400–750 (schema + injected guide) |
| **Bot-detected page (repeat)** | ~120–170 (schema + downgraded hint) |
| **Dialog present on page** | ~120–170 (schema + consent hint) |
| **Subsequent visits** | ~100–150 (schema only; agent remembers) |
| **No guide for site** | ~100–150 (schema only) |

The guide content enters context **once** rather than **every turn**.

---

## 4. Auto-Hint Discovery

### 4.1 The Problem

The agent must discover that guidance exists. Without auto-hint, this requires
the agent to notice `web-guide` in its tool list and make the connection to
the current site — LLMs sometimes make this connection, sometimes don't.

### 4.2 Three-Tier Guide Presence

Guides enter the agent's context through three mechanisms, chosen by category
and trigger configuration. The goal is to match presence intensity to need:
agents that are stuck get full content; agents that just need a nudge get a
hint; agents that can self-serve use the tool on demand.

| Tier | When | Cost | Example |
|------|------|------|--------|
| **Auto-inject** | Condition met + agent likely stuck | ~300–600 tokens | Bot-detected page |
| **Auto-hint** | Condition met + agent can act | ~20 tokens | Site-specific guide, dialog present |
| **On-demand** | Agent calls `web-guide` | ~300–600 tokens | All guides always available |

**Session-level inject suppression.** After the first auto-inject of a guide
in a session, subsequent triggers of the same guide downgrade to auto-hint.
The agent already has the content in context; re-injecting is pure waste.
This is automatic and requires no configuration — it follows the design
principle that guidance enters context once.

**`autoInject` config toggle.** Users who prefer minimal output or who are
working in token-constrained environments can disable auto-inject globally:

```json
{
  "browser": {
    "guides": {
      "autoInject": false
    }
  }
}
```

When `autoInject: false`, all guides that would auto-inject instead auto-hint.
The `web-guide` tool still works normally — the agent can always request the
guide manually. Default is `true` because auto-inject saves more tokens than
it costs on first encounter (prevents 3–5 failed tool calls).

The config is read from `~/.pi/agent/settings.json` via the existing
`plugin-config.ts` mechanism, alongside `browser.plugins`. No new config
infrastructure needed.

How the initial guides map to tiers:

| Guide | Category | Trigger | Presence |
|-------|----------|---------|----------|
| `reddit` | site | — | Auto-hint via DOMAIN_MAP |
| `github` | site | — | Auto-hint via DOMAIN_MAP |
| `bot-detection` | pattern | `signal: "botDetected"` | Auto-**inject** (agent is stuck) |
| `cookie-consent` | pattern | `signal: "dialogPresent"` | Auto-**hint** (agent can see dialog) |
| `pagination` | pattern | — | On-demand only |
| `search` | pattern | — | On-demand only |

### 4.3 Domain-to-Site Mapping

A simple hostname-to-site-name mapping handles discovery, `www.` normalization,
and subdomain variants:

```typescript
interface DomainEntry {
  guide?: string;      // guide name for lookup in GUIDE_CONTENT
  strategy?: string;   // suggested backend strategy (e.g. "stealth" — for future use)
}

const DOMAIN_MAP: Record<string, DomainEntry> = {
  "reddit.com": { guide: "reddit" },
  "www.reddit.com": { guide: "reddit" },
  "old.reddit.com": { guide: "reddit" },
  "github.com": { guide: "github" },
  "hackernews.com": { guide: "hackernews" },
  "news.ycombinator.com": { guide: "hackernews" },
  "www.hackernews.com": { guide: "hackernews" },
  "theguardian.com": { guide: "guardian" },
  "www.theguardian.com": { guide: "guardian" },
  // Future: sites known to require a stealth backend
  // "somesite.com": { guide: "somesite", strategy: "stealth" },
};
```

This mapping is loaded once at startup and cached in memory. Lookup on every
`browser-navigate` is a simple `new URL(url).hostname` + dict check.

**Forward-compatibility with stealth backends.** The `strategy` field is
reserved for future use. When a stealth browser backend becomes available
(via the `chromium-py` plugin infrastructure), entries with `strategy: "stealth"`
will generate hints like:

```
💡 A web guide is available for somesite.com. This site often requires a
   stealth browser — try strategy="stealth". Call web-guide guide="somesite"
   for navigation tips.
```

The `strategy` parameter already exists on `browser-navigate`, so the agent
just needs to know to try it. No code changes to the router or plugin system
are required when the stealth backend lands — only `DOMAIN_MAP` entries need
updating.

### 4.4 Guide Presence in Navigate Output

Guide presence is resolved in `index.ts` (not the router), keeping the
router pure. The `resolveGuidePresence` function checks triggers and
domain maps, then returns the appropriate presence tier.

The navigate result already includes up to three appended lines from the
router: the snapshot disk cache notice (e.g. `📄 Full snapshot cached at
{path}`), a fallback truncation hint, and the fingerprint line. Guide
content is appended **after** these, separated by a blank line, so it
doesn't interfere with cache-path parsing.

**Auto-hint** appends a one-line nudge:

```
… 15 elements total
📄 Full snapshot cached at /tmp/pi-browser/snapshot-browser-1-a1b2c3d4-0.txt
   15 elements total — read the cache file for the exact ARIA tree, or use browser-inspect for quick targeted element discovery
fingerprint:abc123

💡 A web guide is available for reddit.com.
   Call web-guide guide="reddit" for navigation tips.
```

**Auto-inject** (first time) appends the full guide content:

```
… 2 elements total
fingerprint:def456

## Bot Detection Patterns

### When You See a Challenge Page
- Cloudflare: "Just a moment..." — wait 5–10 seconds...
...

_Call web-guide guide="bot-detection" to see this guide again._
```

**Auto-inject downgrade** (subsequent triggers in same session) appends
just the hint:

```
⚠️ Bot detection triggered again. Call web-guide guide="bot-detection" for strategies.
```

```typescript
// ── Guide presence resolution ─────────────────────────────────────

/** Track which guides have been auto-injected this session. */
const injectedGuides = new Set<string>();

/** Check if a dialog is present in the snapshot text. */
function dialogPresentInSnapshot(snapshot: string): boolean {
  return snapshot.includes('role="dialog"') ||
         snapshot.includes('role="alertdialog"');
}

/** Resolve which guide presence to show, if any. */
function resolveGuidePresence(
  url: string,
  result: NavigateResult & { botDetectionWarning?: boolean },
  domainMap: Record<string, DomainEntry>,
  guides: Record<string, Guide>,
  autoInjectConfig: boolean,
): { type: "inject" | "hint"; guideName: string; text: string } | undefined {
  // 1. Bot-detection trigger — highest priority
  if (result.botDetectionWarning) {
    const guide = guides["bot-detection"];
    if (guide?.trigger?.signal === "botDetected") {
      if (autoInjectConfig && !injectedGuides.has("bot-detection")) {
        injectedGuides.add("bot-detection");
        return {
          type: "inject",
          guideName: "bot-detection",
          text: guide.content,
        };
      }
      return {
        type: "hint",
        guideName: "bot-detection",
        text: "⚠️ Bot detection triggered. Call web-guide guide=\"bot-detection\" for strategies.",
      };
    }
  }

  // 2. Dialog trigger — check for consent dialogs in snapshot
  if (dialogPresentInSnapshot(result.snapshot)) {
    const guide = guides["cookie-consent"];
    if (guide?.trigger?.signal === "dialogPresent" && guide.trigger.presence === "hint") {
      return {
        type: "hint",
        guideName: "cookie-consent",
        text: "💡 A consent dialog is present. Call web-guide guide=\"cookie-consent\" for dismissal patterns.",
      };
    }
  }

  // 3. Domain-based hint — site guides via DOMAIN_MAP
  const entry = domainMap[new URL(url).hostname];
  if (entry?.guide && guides[entry.guide]) {
    let text = `💡 A web guide is available for ${url}.\n   Call web-guide guide="${entry.guide}" for navigation tips.`;
    if (entry.strategy) {
      text += `\n   This site often requires a stealth browser — try strategy="${entry.strategy}".`;
    }
    return { type: "hint", guideName: entry.guide, text };
  }

  return undefined;
}

// In index.ts, browser-navigate tool's execute()
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const result = await router.navigate(params.url, taskId, strategy);
  const autoInjectConfig = readGuidesConfig().autoInject;  // from settings.json

  const presence = resolveGuidePresence(
    params.url, result, DOMAIN_MAP, GUIDE_CONTENT, autoInjectConfig,
  );

  let output = renderNavigateResult(result);
  if (presence) {
    if (presence.type === "inject") {
      output += "\n\n" + presence.text +
        `\n\n_Call web-guide guide="${presence.guideName}" to see this guide again._`;
    } else {
      output += "\n\n" + presence.text;
    }
  }
  return { content: [{ type: "text", text: output }] };
}
```

The `resolveGuidePresence` function evaluates conditions in priority order:
1. **Bot-detection trigger** — highest priority, agent is stuck
2. **Dialog trigger** — consent dialogs present in the snapshot
3. **Domain-based hint** — site guides via `DOMAIN_MAP`

At most one guide presence is shown per navigate result. The first matching
condition wins. This keeps the navigate output focused and avoids stacking
multiple hints.

The `injectedGuides` set is scoped to the task session and cleared on session
removal. It tracks guide names (not domains) — navigating to `reddit.com`
(bot-detected, inject) then `github.com` (bot-detected, also injects) would
inject bot-detection on the first visit and hint on the second, because the
agent already has the content from the first injection.

The `dialogPresentInSnapshot` check is a lightweight string scan on content
the router already produced. It detects `role="dialog"` and
`role="alertdialog"` in the accessibility tree text. This is not the same as
the `formatDialogLog()` mechanism in `cdp-supervisor.ts`, which tracks JS
`alert()`/`confirm()`/`prompt()` dialogs that Chromium auto-dismisses. Cookie
consent dialogs are DOM elements with ARIA roles, not native browser dialogs.

---

## 5. Tool Selection in Guide Content

*Background — already implemented. This section documents the design
rationale so guide authors understand which tools to recommend.*

Guides recommend tools for the agent to use. Two content types need two
different tools, and `maxChars` only applies to one of them:

| Content Type | Tool | Control | Why |
|-------------|------|---------|-----|
| ARIA tree (structured) | `browser-snapshot` | `full=true` — boolean choice between compact vs complete tree | Agent knows exactly what it's getting |
| Page text (linear) | `browser-inspect text=true` | `maxChars` — quantitative choice about how much to read | Agent can predict output length |

### 5.1 Why `maxChars` Is Wrong for ARIA Trees

ARIA trees are **structured** — they describe interactive elements, roles,
hierarchical relationships. `compactSnapshot()` does smart truncation: it
preserves the most important interactive elements and cuts at natural
breakpoints. `maxChars=N` is dumb character-count truncation on a structured
tree — the agent can't predict what `maxChars=5000` will show vs
`maxChars=3000`. This is why `maxChars` was not added to `browser-navigate`
or `browser-snapshot`.

### 5.2 Why `maxChars` Is Right for Text Extraction

Text content is **linear** — article body, paragraph text, link text. "Show me
the first 3000 chars of this article" is a reasonable, predictable request.
This is why `browser-inspect text=true maxChars=3000` works well.

### 5.3 The Snapshot Disk Cache

When `compactSnapshot()` truncates a snapshot, the full tree is written to a
temp file (`/tmp/pi-browser/snapshot-*.txt`). The agent can `read` this file
with offset/limit to find elements past the truncation boundary. `@e` refs
remain valid because the element cache is independent of what text the agent
reads. Guides can reference this when the agent needs to see *all* elements
on a large page.

### 5.4 Guide Recommendations

Guides should recommend the cheapest effective path:

| Goal | Recommendation |
|------|--------------|
| Quick check for a dialog | `browser-inspect role="dialog"` — returns matching elements from cache, no page interaction |
| Read page content | `browser-inspect text=true` — text extraction with `@e` refs; use `maxChars` to control length |
| Find a specific element | `browser-inspect role="..." name="..."` — targeted cache query |
| Full ARIA tree (complex interaction) | `browser-snapshot full=true` — escape valve, most expensive |
| All elements on a large page | Read the cached snapshot file (path in cache notice) |

Example guide advice using these tools:

```
Start with browser-inspect role="dialog" to check for the consent dialog.
If it's gone, use browser-inspect text=true to read the feed content.
Use browser-snapshot full=true only if you need the complete tree for complex interaction.
```

---

## 6. What Does NOT Change

These existing layers are foundational and remain untouched. Guides provide
knowledge; these layers provide runtime safety. They coexist cleanly.

| Layer | Why It Stays |
|-------|-------------|
| Router-appended truncation hints | `compactSnapshot()` outputs a pure truncation tail; the router appends cache notices and fallback hints. Guides don't replace these — they supplement with site-specific knowledge. |
| Snapshot disk cache (`snapshot-cache.ts`) | Caches full trees on truncation; guide content can reference cache files but doesn't change the caching mechanism. |
| `browser_finetuning.md` | Institutional knowledge about occlusion/dialog methodology. Future maintainers need the rationale. |
| `checkOcclusion()` | Runtime occlusion detection via `elementFromPoint`. Guides can say "watch out" but can't replace the check. |
| `verifyClick` fallback | Runtime safety net for false-positive occlusion. |
| `url-safety.ts` | SSRF, secret, scheme validation. Security boundary. Never knowledge-driven. |
| `bot-detection.ts` | Heuristic Cloudflare/CAPTCHA detection. Guides supplement, don't replace. |
| `plan_v2.md` | Authoritative architecture rationale. Archive only when architecture is stable (v3+). |

---

## 7. Implementation Steps

1. **Define `web-guide` tool** in `index.ts` with `guide` parameter, guide
   content map, category-aware listing, and staleness warning logic (~80 lines)
2. **Add `GuideCategory`, `GuideTrigger`, and `Guide` types** with `category`
   and `trigger` fields; add `DomainEntry` type and `DOMAIN_MAP` with
   hostname-to-entry resolution and optional `strategy` field (~50 lines)
3. **Add `resolveGuidePresence` function** with trigger-based auto-inject and
   auto-hint logic, `dialogPresentInSnapshot` check, session-level inject
   suppression via `injectedGuides` set, and `autoInject` config toggle
   (~60 lines)
4. **Wire guide presence into `browser-navigate`** tool output, appending
   inject content or hint text after cache/fingerprint lines (~15 lines)
5. **Add `readGuidesConfig`** to read `browser.guides.autoInject` from
   `settings.json` via existing `plugin-config.ts` mechanism (~10 lines)
6. **Start with 4 pattern guides** (cookie-consent, pagination, search,
   bot-detection) and 2 site-specific guides (reddit, github), recommending
   `browser-inspect` where it's the cheaper path
7. **Add tests** for `resolveGuidePresence` (all three tiers + suppression),
   `dialogPresentInSnapshot`, `formatGuideList`, `web-guide` tool execution,
   and `autoInject: false` config (~70–100 lines)
8. **Update `AGENTS.md`** — document web-guide tool, three-tier presence,
   categories, auto-inject with session suppression, and `autoInject` config

**Total new code: ~285–315 lines** (including tests). No changes to router core,
plugin system, session management, or existing safety nets. No new tool
parameters on existing tools — guides simply recommend the right combination
of existing tools (`browser-inspect`, `browser-snapshot`, cached snapshots).

---

## 8. Deferred

| Feature | Reason |
|---------|--------|
| **Agent-generated guides ("build a guide")** | Single-visit exploration produces low-quality guides. Requires real-time user interaction, breaks async model, introduces filesystem trust boundaries. |
| **User-authored guides directory** | Start with guides in code. Externalize to `~/.pi/agent/skills/pi-browser/` after proving value with hand-authored content. |
| **Guide freshness monitoring** | Display staleness warnings when `updated` is older than threshold. Add when users encounter stale guides. |
| **Domain-aware conditional injection** | When pi supports `registerSkill` API, migrate from guide-tool to real skills with conditional context. |
| **Per-guide auto-inject config** | Only one auto-inject guide exists in v1 (bot-detection). A per-guide config map is premature; the global `autoInject` boolean is sufficient. Revisit at 5+ auto-inject guides. |
| **Richer trigger conditions** | Triggers are intentionally narrow (two signals, two presence modes). New triggers (e.g. "large page" for pagination) require code review, not config composition. This is the right default for v1. |
| **`dialogDetected` field on `NavigateResult`** | The string-scan `dialogPresentInSnapshot()` is sufficient for v1. A proper field would require plugin-level changes. Revisit if string-scan proves unreliable across sites. |

---

## 9. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Stale guide content** | Medium | Guides carry `updated` date + optional `staleAfterDays` for runtime warnings; guides include staleness disclaimers (e.g. "If the described elements don't appear, fall back to browser-inspect"); stale guides are advisory, not authoritative |
| **Agent ignores auto-hint** | Low | Worst case = same as today (discovery cost). Agent can still call `web-guide` manually. Bot-detection hint is more urgent and uses ⚠️ emoji for visibility |
| **Guide content accumulates in conversation** | Low | Guides are ~300–600 chars; small compared to snapshot output (~2500 chars); auto-inject fires at most once per guide per session |
| **Repeated auto-inject on same guide** | Medium | Session-level `injectedGuides` set downgrades to hint after first inject; `autoInject: false` config for users who never want inject |
| **Domain mapping needs updates for variants** | Low | Simple JSON object; add entries as needed; missing subdomains fall back to no-hint |
| **Tool schema adds ~100–150 tokens/turn** | Low | Fixed cost paid once; savings on first-visit discovery (5–8 tool calls → 1–2) far exceed overhead |
| **Guide content exceeds size cap** | Low | Authoring discipline enforced by review; no runtime truncation (would silently degrade guidance quality) |
| **Bot-detection hint on false positives** | Low | Router already handles `elementCount < 5` downgrade to failure; hint only fires on surviving bot-detected pages where agent can still act |
| **`dialogPresentInSnapshot` false positive** | Low | String scan on `role="dialog"` may match non-consent dialogs (e.g. modals). The hint is advisory ("a consent dialog is present") — if wrong, the agent ignores it at no cost beyond ~20 tokens |

---

## 10. Appendix: Example Guide Content

Each guide below includes its `category` and `trigger` (if any) for reference.
These fields are defined in `GUIDE_CONTENT`, not in the markdown itself —
the markdown is the `content` field value.

### cookie-consent

`category: "pattern"` · `trigger: { signal: "dialogPresent", presence: "hint" }`

```markdown
## Cookie Consent Patterns

### Common Dialog Indicators
- role="dialog" or role="alertdialog" at the top of the accessibility tree
- Buttons containing "Accept All", "Reject All", "Decline", "Manage"
- Pressing Escape dismisses many consent dialog variants
- Use `browser-inspect role="dialog"` to quickly check if a dialog is present
  without loading a full snapshot

### Navigation After Dismissal
- After dismissing consent, use `browser-inspect role="dialog"` to confirm
  the dialog is gone — cheaper than a full snapshot
- If `browser-inspect` shows stale refs, take a fresh `browser-snapshot`
- Some sites reload; others hide the dialog client-side. Either way,
  verify before interacting with page content
```

### pagination

`category: "pattern"` · no trigger (on-demand only)

```markdown
## Pagination Patterns

### Common Patterns
- "Next" or "→" button is role="button" or role="link"
- Page numbers may be role="list" with role="listitem" per page
- Infinite scroll: use browser-scroll to load more content
- After scrolling, take a fresh snapshot — new elements may appear

### Progressive Loading
- Use `browser-inspect text=true maxChars=500` for an initial scan of
  page content, then `maxChars=0` for the full text after confirming
  content has loaded
- Use `browser-inspect role="button" name="next"` to find pagination
  controls without loading the full tree
- After scrolling, wait briefly before taking snapshot (content may
  still be loading)
```

### search

`category: "pattern"` · no trigger (on-demand only)

```markdown
## Search Patterns

### Common Patterns
- Search bar is role="searchbox" or role="combobox"
- Keyboard shortcut "/" focuses search on many sites (use browser-press)
- Results may load in-page (SPA) or via navigation

### After Searching
- Use `browser-inspect text=true` to read search results with @e refs,
  rather than loading a full snapshot
- Results are often role="list" with role="listitem" per result
- Pagination controls follow the patterns in the pagination guide
```

### bot-detection

`category: "pattern"` · `trigger: { signal: "botDetected", presence: "inject" }`

```markdown
## Bot Detection Patterns

### When You See a Challenge Page
- Cloudflare: "Just a moment..." or "Checking your browser" — wait 5–10
  seconds, some challenges auto-resolve after JavaScript execution
- After waiting, take a fresh `browser-snapshot` to see if the real page loaded
- If still blocked, try `web-fetch` on the same URL — it doesn't execute JS
  challenges and sometimes succeeds where the browser doesn't
- If both fail, the site is blocking automation and cannot be accessed

### What NOT to Do
- Don't try to click through CAPTCHA challenges — automated clicks are
  fingerprinted and often cause permanent blocks
- Don't retry navigation rapidly — rate limits escalate the challenge difficulty
- Don't assume the page is broken — `browser-screenshot` can show you
  what's actually rendered

### Backend Strategy
- The default `chromium` backend is detected by many anti-automation systems
- A stealth browser backend may be available — try `browser-navigate` with
  `strategy="stealth"` if the default backend is blocked
- If no stealth backend is configured, this will fail with a clear error —
  no harm in trying

### Verifying the Page After a Challenge
- Use `browser-inspect role="dialog"` to check if a challenge dialog is
  still present — cheaper than a full snapshot
- If the dialog is gone, use `browser-inspect text=true` to read the actual
  page content
- Some sites reload after challenge completion — if `browser-inspect`
  shows stale refs, take a fresh `browser-snapshot`

_Last verified against common Cloudflare and Akamai challenge patterns.
If the described elements don't appear, fall back to `browser-inspect`
and `browser-screenshot` to discover the current page structure._
```

### reddit

`category: "site"` · discovered via `DOMAIN_MAP`

```markdown
## Reddit Navigation Patterns

### Bot Detection
Reddit may show a Cloudflare challenge on first visit.
- If you see "Just a moment...", wait 5–10 seconds for auto-resolution
- If the challenge persists, try `web-fetch` on the same URL as a fallback
- See the `bot-detection` guide for full strategies

### Consent Dialog (First Visit)
Reddit shows a data consent dialog (role="dialog").
- Use `browser-inspect role="dialog"` to confirm it's present
- Look for a button containing "Reject All" or "Decline"
- Pressing Escape also dismisses some variants
- After dismissing, use `browser-inspect role="dialog"` to confirm it's gone
- A second "welcome" dialog may appear — check again

### Feed
- Main feed uses role="table" or role="list"
- Post titles are role="link" or role="rowheader"
- Use `browser-inspect text=true` to read post content without loading
  the full ARIA tree
- Use browser-scroll to load more content

### Search
- Search bar is role="combobox" with name "Search"
- Results load in-page (SPA navigation)
- After searching, use `browser-inspect text=true` to read results
```

### github

`category: "site"` · discovered via `DOMAIN_MAP`

```markdown
## GitHub Navigation Patterns

### Repo Page
- File list is role="table"; filenames are role="link" or role="cell"
- Navigation tabs (Code, Issues, Pull requests) are role="tab"
- Use `browser-inspect role="tab"` to find tabs without a full snapshot

### Pull Requests
- PR list uses role="list" with role="listitem" per PR
- "Files changed" tab shows diffs

### Search
- Global search is role="combobox" at the top
- Keyboard shortcut "/" focuses the search box
- Results page uses role="list"
- After searching, use `browser-inspect text=true` to read results

### Known Quirks
- No consent dialogs, rarely triggers bot detection
- GitHub uses client-side routing — use `browser-inspect` after clicking
  links to check for stale @e refs; if stale, take a fresh `browser-snapshot`
```
