# Custom Web Skills for pi-browser

> Date: 2026-06-11
> Status: **Proposed** — site-specific navigation guidance delivered as skill-tools,
> managed by the `/web` command lifecycle.

---

## 1. Problem

Every time the agent visits a site it hasn't learned, it wastes 5–8 tool calls
reverse-engineering the page structure: which @e refs are clickable, which
dialog to dismiss, where the content actually lives. Repeated visits repeat
the same discovery cost. The system has no way to **accumulate and reuse**
site-specific navigation knowledge.

The core browser tools (`browser-navigate`, `browser-click`, `browser-type`)
are correct as a **foundation layer**, but they force every agent to reason
at the level of individual keystrokes. An abstraction layer is needed so the
agent can describe *what* to do rather than *how* to do it.

---

## 2. Design

### 2.1 Concept: Skill-Tools

Site-specific navigation guides are registered as **tools with `promptGuidelines`
but no substantive execution**. They get injected into the system prompt only
when active and vanish completely when removed via `setActiveTools()`.

This is not a new mechanism — it's `promptGuidelines` and `setActiveTools()`
used exactly as designed:
- Tool active → `promptGuidelines` in system prompt
- Tool inactive → guidelines gone, **zero token cost**
- Managed by the existing `/web` command, which already owns tool lifecycle

A skill for Reddit looks like:

```typescript
const redditSkill = defineTool({
  name: "web-skill:navigate-reddit",
  description:
    "Navigate Reddit effectively: consent dialogs, feed scrolling, " +
    "search, and subreddit patterns. Use with browser-navigate.",
  promptGuidelines: [
    "Reddit shows a consent dialog on first visit with role='dialog'.",
    "The 'Reject All' button contains a nested SVG icon — occlusion " +
    "verify-click fallback may be needed.",
    "After dismissing consent, a second 'welcome' dialog may appear " +
    "(also role='dialog').",
    "The main feed uses role='table' with role='rowheader' for post " +
    "titles. Use browser-scroll to load more content.",
    "Reddit search uses role='combobox' with name='Search'. Results " +
    "load in-page, not via navigation.",
    "Pressing Escape dismisses some dialog variants.",
  ],
  parameters: Type.Object({}),
  async execute() {
    return {
      content: [{ type: "text", text:
        "This is a navigation guide. Use browser-navigate to visit " +
        "reddit.com and the guidance above to interact." }],
    };
  },
});
```

### 2.2 Skill Grouping

Skills are grouped by domain name for command targeting:

```typescript
const WEB_SKILLS: Record<string, string[]> = {
  reddit:      ["web-skill:navigate-reddit"],
  github:      ["web-skill:navigate-github"],
  hackernews:  ["web-skill:navigate-hacker-news"],
  guardian:    ["web-skill:navigate-guardian"],
};
```

Core browser tools (no skill grouping, always co-enabled with at least one skill):

```typescript
const CORE_BROWSER_TOOLS = [
  "browser-navigate", "browser-snapshot", "browser-click",
  "browser-type", "browser-scroll", "browser-screenshot",
  "browser-get-images", "browser-back", "browser-press",
  "browser-console", "web-fetch",
];
```

### 2.3 Token Cost When Active

| Active skills | Description tokens | Guideline tokens | Total |
|--------------|-------------------|-----------------|-------|
| 1 skill | ~100 | ~400 | ~500 |
| 5 skills | ~500 | ~2000 | ~2500 |
| 10 skills | ~1000 | ~4000 | ~5000 |

When `/web off`, **zero** of these tokens are in context. This is the
critical property the real-skill approach cannot achieve.

---

## 3. Command Design

### 3.1 Syntax

```
/web on                        # All browser tools + all web skills
/web off                       # Remove all browser tools + all web skills
/web status                    # Show active tools and skills
/web reddit on                 # Activate reddit skill + browser tools
/web reddit off                # Deactivate reddit skill only
/web github on reddit off      # Compound: add github, remove reddit
```

### 3.2 Semantics

- `/web <skill> on` activates the skill **and** core browser tools
  (a skill is useless without the tools it talks to).
- `/web <skill> off` deactivates only that skill's tool. Browser tools
  stay active if any other skill is still enabled.
- `/web off` removes everything (core tools + all skills).
- `/web on` restores everything.
- `/web status` shows which skills and tools are active.

### 3.3 State Persistence

Per-skill state is persisted via `appendEntry`, surviving `/reload`,
`/resume`, `/fork`:

```typescript
ctx.appendEntry("web-skill-state", { name: "reddit", enabled: true });
```

On `session_start`, the extension scans the branch for `web-skill-state`
entries and restores them. The global toggle state (from the existing
`browser-toggle.ts`) is restored first, then per-skill state is overlaid.

### 3.4 Default Configuration

The `settings.json` can declare which skills are enabled by default:

```jsonc
{
  "browser": {
    "defaultSkills": ["reddit", "github"]  // enabled on /web on
  }
}
```

If unspecified, all skills ship as active when `/web on`.

---

## 4. Layering

```
┌─────────────────────────────────────────────────────┐
│              AI Agent (reasoning)                   │
├─────────────────────────────────────────────────────┤
│  Web Skill-Tools (promptGuidelines context)         │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │
│  │ navigate-   │ │ navigate-   │ │ navigate-    │  │
│  │ reddit      │ │ github      │ │ hackernews   │  │
│  └─────────────┘ └─────────────┘ └──────────────┘  │
├─────────────────────────────────────────────────────┤
│  Core Browser Tools (browser-navigate, click, etc.) │
├─────────────────────────────────────────────────────┤
│  Router (truncation, URL safety, session mgmt)      │
├─────────────────────────────────────────────────────┤
│  BrowserPlugin (BrowserPlugin interface + registry)  │
├─────────────────────────────────────────────────────┤
│  Backends (Chromium Node, Chromium-Py)              │
└─────────────────────────────────────────────────────┘
```

---

## 5. Layer Deprecation and Simplification

The skills approach eliminates the need for several existing layers that
were built to solve the same problem (help the agent navigate complex
pages) but do it in a generic, code-driven way rather than a knowledge-driven
way.

### 5.1 Dialog-Aware Snapshot Truncation — **Simplify**

**What it is:** ~100 lines in `core/router.ts` (`compactSnapshot` + `extractDialogBlocks`
+ `truncateDialogBlock`) that detect `💬 dialog` and `⚠ alertdialog` blocks
beyond the truncation cutoff and re-attach them to the compacted output.

**Why skills replace it:** A skill says "Reddit has a consent dialog with
role='dialog' — use `full=true` if the compact snapshot doesn't show it."
The agent already knows the dialog exists and knows to request the full
tree. It doesn't need the system to fight to preserve it at truncation time.

**What to keep:** The basic truncation logic (cut at natural breakpoint near
2500 chars, add tail hint). Remove `extractDialogBlocks()` (lines ~120–200
in router.ts) and the dialog re-attachment loop.

**Savings:** ~80 lines in `core/router.ts`, simpler code path, fewer edge cases.

### 5.2 Snapshot Fingerprint DOM-Change Detection — **Simplify**

**What it is:** `snapshotFingerprint()` in `accessibility-tree.ts` (~20 lines) +
the fingerprint comparison logic in `compactInteractionResult()` in `router.ts`
(~25 lines) that warns the agent when page structure changed between interactions.

**Why skills replace it:** A skill encodes "after clicking 'Accept All', the
page will reload and @e refs will be stale — take a fresh snapshot." The
agent already knows the page will change. The warning is noise on top of
knowledge the agent already has.

**What to keep:** The fingerprint function itself (cheap hash, could be useful
for other things). Remove the warning injection in `compactInteractionResult()`.

**Savings:** ~25 lines in `core/router.ts`, 3 fields removed from `BrowserSession`
(`currentSnapshotFingerprint`), ~5 lines in `session-manager.ts`.

### 5.3 `browser_finetuning.md` — **Archive**

**What it is:** 11-section, ~8000-word diagnostic strategy document covering
occlusion detection, dialog experiments, Reddit fixture design, timing analysis,
and root-cause methodology.

**Why skills replace it:** The experimental findings are already baked into the
code (occlusion verify-click fallback, dialog prioritisation, fingerprint
warnings). The methodology is valuable as a reference but shouldn't live as
active documentation in the repo — it's ~8KB of tokens that could be in
context elsewhere.

**What to keep:** Archive to `docs/` or remove entirely. The experimental
findings are captured in the code itself (comments in `checkOcclusion()`,
`parseSnapshot()`, etc.).

**Savings:** 8KB of repo weight, cleaner `AGENTS.md`.

### 5.4 Experiment Artifacts in `scripts/` — **Archive**

**What it is:** 7 files in `scripts/`:
- `experiment-{1..5}-findings.md` — individual experiment reports
- `baseline-reddit-2026-06-11.md` — baseline results
- `phase5-validation.md` — validation report

These are historical artifacts from the fine-tuning experiments. They are
not active code, not tested, and not referenced by any other file.

**What to keep:** Archive to `docs/experiments/` or remove. The
`dialog-gate.ts` side-by-side runner is still useful for backend comparison
tests — keep that.

**Savings:** ~6 files, ~20KB of historical noise.

### 5.5 `plan_v2.md` — **Archive**

**What it is:** The plugin architecture v2 plan. The refactor is complete.
This document served its purpose during implementation.

**What to keep:** Archive to `docs/`. The architecture is now documented
in the code itself (interface comments, `AGENTS.md`).

**Savings:** ~50 lines from `AGENTS.md` reference section, 15KB of stale
architecture doc.

---

## 6. What Stays

These layers are foundational and **not** simplified by skills:

| Layer | Why It Stays |
|-------|-------------|
| `BrowserPlugin` interface | Core extensibility contract. Skills are client-side, plugins are server-side. |
| `PluginRegistry` | Plugin resolution. Skills don't replace plugin management. |
| `SessionManager` | Session lifecycle (create, recover, crash). Skills don't manage sessions. |
| `fetch-backend.ts` | Stateless HTTP fetch. Skills talk about interactive browsing, not static fetch. |
| `cdp-supervisor.ts` | Dialog auto-dismissal + console capture. Runtime infrastructure, not knowledge. |
| `bot-detection.ts` | Heuristic Cloudflare/CAPTCHA detection. Skills can supplement but not replace. |
| `url-safety.ts` | SSRF, secret, scheme validation. Security boundary. Never knowledge-driven. |
| `checkOcclusion()` | Runtime occlusion detection via `elementFromPoint`. Skills can say "watch out" but can't replace the check. |
| `parseSnapshot()` | ARIA tree parsing + @e ref assignment. Runtime parsing, not knowledge. |
| `compactSnapshot()` (basic) | Simple truncation to ~2500 chars. Keep the core, remove dialog re-attachment. |
| `verifyClick` fallback | 1.5s click attempt for false-positive occlusion. Runtime safety net. |

---

## 7. Example Skill Content

### navigate-reddit

```markdown
---
name: navigate-reddit
description: Navigate Reddit: consent dialogs, feed browsing, search, subreddit navigation
---

## Reddit Navigation Patterns

### Consent Dialog (First Visit)
Reddit shows a data consent dialog. It has role="dialog".
- Look for a button containing "Reject All" or "Decline". It may contain a nested
  SVG icon — the occlusion verify-click fallback handles this.
- Pressing Escape also dismisses some variants.
- After dismissing, a second "welcome" or "get the app" dialog may appear.

### Feed
The main feed uses role="table" or role="list".
- Post titles are role="link" or role="rowheader".
- Use browser-scroll to load more content.
- Each post row has comment count as a role="link".

### Search
- Top search bar is role="searchbox" or role="combobox" with name "Search".
- Results load in-page (SPA navigation). Take a fresh snapshot after typing.
```

### navigate-github

```markdown
---
name: navigate-github
description: Browse GitHub: repo navigation, PR review, file browsing, search
---

## GitHub Navigation Patterns

### Repo Page
- The file list is role="table". Filenames are role="link" or role="cell".
- The code view uses role="region" for the main code block.
- Navigation tabs (Code, Issues, Pull requests) are role="tab" in a role="tablist".

### Pull Requests
- PR list uses role="list" with each PR as role="listitem".
- The "Files changed" tab is role="tab" — click it to see diffs.
- Each file diff has role="region" for added/removed blocks.

### Search
- Global search is role="searchbox" or role="combobox" at the top.
- Keyboard shortcut "/" focuses the search box (use browser-press key="/").
- Results page uses role="list" with role="listitem" per result.

### Known Quirks
- No consent dialogs.
- GitHub uses client-side routing. After clicking a link, take a fresh
  snapshot — @e refs from the previous page are stale.
```

---

## 8. Implementation Steps

1. **Define skill-tool registrations** in `index.ts` alongside existing tools
   (~50 lines for a few skills)
2. **Extend `/web` command** in `browser-toggle.ts` to parse skill names
   (~30 lines)
3. **Add per-skill state persistence** via `appendEntry`
   (~20 lines)
4. **Restore skill state on `session_start`**
   (~15 lines)
5. **Simplify `compactSnapshot`** — remove `extractDialogBlocks` and dialog
   re-attachment loop (~80 lines deleted)
6. **Simplify `compactInteractionResult`** — remove fingerprint warning
   injection (~25 lines deleted)
7. **Archive** `browser_finetuning.md`, `plan_v2.md`, experiment findings
   in `scripts/`
8. **Update `AGENTS.md`** — document skill-tool pattern and `/web` syntax

---

## 9. Future Work

- **Skill authoring tool** — `browser-learn` that captures a browsing session
  and generates a skill-tool draft for the user to review.
- **Domain-aware injection** — When pi supports conditional skill context
  (via `registerSkill` API), migrate from skill-tools to real skills while
  keeping the `/web` lifecycle control.
- **User-authored skills** — Allow users to create skills for sites they
  visit, stored in `~/.pi/agent/skills/pi-browser/` and registered into
  the `WEB_SKILLS` map.
- **Cross-cutting pattern skills** — Shared patterns (cookie consent, OAuth
  flows, pagination) extracted into reusable fragments referenced by site
  skills.
