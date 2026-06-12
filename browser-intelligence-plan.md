# Browser Intelligence Plan

> Date: 2026-06-12
> Status: **Proposed** — unified implementation plan
> Supersedes: `snapshot-cache-query-plan-v2.md`, `dom-extractor.md`,
>             `web-guides-proposal.md` (maxChars section only)

---

## 0. Why This Document Exists

Three separate proposals addressed overlapping aspects of the same problem:

| Document | What it solved | What it missed |
|----------|---------------|----------------|
| `snapshot-cache-query-plan-v2.md` | Truncation loses elements; no way to query them | The ARIA tree never captured text content in the first place |
| `dom-extractor.md` | The agent can't read page content | No link between text and @e refs; conflicts with v2's architecture |
| `web-guides-proposal.md` | Site navigation knowledge isn't reusable | `maxChars` design conflicted with v2's purity principle |

This document unifies them into one coherent plan with consistent architecture, no conflicting designs, and a single implementation order.

---

## 1. The Problem

The agent browsing a page has two fundamental gaps:

**Gap 1 — Information loss from truncation.** `compactSnapshot()` truncates the accessibility tree to ~2500 chars. Elements past the cut line vanish. The agent can't click what it can't see.

**Gap 2 — The ARIA tree was never a reading layer.** `page.ariaSnapshot()` is a screen-reader utility. It answers "where are the interactive elements?" but not "what does this page say?" The agent has `@e` refs it can click, but zero text content to understand what it's looking at. It's browsing blindfolded with a clicker in hand.

**Gap 3 — No bridge between reading and interaction.** Even if the agent could see text content, it has no way to correlate "I want to click the link about compiler optimization" with the specific `@e` ref that represents that link.

The three gaps form a chain: the agent can't see all the elements, can't read the content, and can't connect what it reads to what it can click.

---

## 2. Architecture Principles

These are non-negotiable constraints derived from oracle review and cross-proposal conflict resolution.

### P1: `compactSnapshot()` stays pure

Signature unchanged: `(snapshot: string, elementCount: number) → string`. No `maxChars`, no DOM text injection, no disk I/O. All enrichment happens in the router. This was v2 Decision #4 and it's correct — the compaction function has 422 tests depending on it, and mixing concerns makes it untestable.

### P2: The router is the composition layer

Disk caching, `maxChars` post-processing, DOM text formatting, and cache notice construction all live in the router. `compactSnapshot()` truncates; the router decides what to do with the result. This is the same pattern `web-fetch` uses — `capFetchContent()` wraps the raw fetch, not the other way around.

### P3: The ARIA tree is for interaction, the DOM walker is for reading

The ARIA tree's job is to produce deterministic `@e` refs that map to `getByRole()` locators. Text nodes (`paragraph`, `text`) appear in the tree but don't get `@e` refs because they can't be interacted with. This is correct — giving them refs would break the "you can click this" contract.

The DOM walker's job is to extract readable content — headings, paragraphs, links with context, images with alt text. It runs via `page.evaluate()` and returns structured data.

These two layers are complementary. They should not be merged into a single output (dom-extractor Option B), because that shifts truncation boundaries, bloats every snapshot, and makes the ARIA tree worse at its primary job.

### P4: New `BrowserPlugin` interface methods require justification

`getElementCache(taskId)` is justified because the element cache lives inside each plugin and can't be accessed any other way. A `getText()` method is not justified — the extractor script runs via the existing `evaluate()` method. The plugin interface should stay lean; each addition couples the framework to a specific tool's needs.

### P5: `maxChars` has one consistent design

- `maxChars=0` → no truncation (full output)
- `maxChars=undefined` → auto (compact ~2500 for snapshots, ~3000 for text)
- `maxChars>0` → explicit limit
- Applied as router post-processing after `compactSnapshot()`, NOT inside it
- Deprecates `full` parameter (`maxChars=0` replaces `full=true`)
- Consistent across `browser-navigate`, `browser-snapshot`, and `browser-inspect`

### P6: @e ref correlation is a first-class feature

When the agent reads text content, that text must be annotated with `@e` refs where possible. Without correlation, the agent gets two parallel views of the page with no bridge between them. Correlation uses role + name matching between the DOM walker output and the element cache — fuzzy but far better than zero.

---

## 3. Features

### Feature A: Snapshot Disk Cache

**Source:** v2 Feature A, unchanged.

When `compactSnapshot()` truncates, write the full untruncated tree to a temp file. The agent can `read` it with offset/limit to find elements past the truncation boundary. `@e` refs in the cached file are still valid — the router resolves them from the plugin's in-memory element cache, not from whatever text the agent last saw.

Key design points:
- Only cache when truncation actually occurred (snapshot > 2800 chars)
- Bot-detected snapshots are never cached (misleading content)
- Keep last 2 files per task (timestamped filenames)
- Try-catch on writeFileSync — graceful degradation to inline only
- Cache notice includes fingerprint for staleness detection
- Interaction results that navigate to a new page are also cached
- Cleanup on session removal

New module: `core/shared/snapshot-cache.ts` with `cacheSnapshot()`, `removeSnapshotFiles()`, `removeAllSnapshotFiles()`, `formatCacheNotice()`.

### Feature B: `browser-inspect` Tool (Merged Query + Text)

**Source:** v2 Feature B (`browser-query`) + dom-extractor (`browser-get-text`), merged.

A single tool that queries the page from two data sources:

| Mode | Data source | Trigger | Speed |
|------|-----------|---------|-------|
| Element query | In-memory element cache | `role`, `name`, `ref`, or `subtree` params | Sync, instant |
| Text extraction | Live DOM via `page.evaluate()` | `text=true` | Async, ~100ms |

When both modes are used together (`text=true` + filters), the DOM walker runs and the results are filtered by the same criteria and annotated with `@e` refs from the element cache.

#### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `role` | `string?` | Filter by ARIA role. Comma-separated for multiple. E.g. `"link,button"` |
| `name` | `string?` | Filter by accessible name (case-insensitive substring match) |
| `ref` | `string?` | Look up a specific @e ref. E.g. `"e5"` or `"e42"` |
| `subtree` | `string?` | Scope to elements inside a container role. E.g. `"dialog"`, `"navigation"` |
| `text` | `boolean?` | Include text content from DOM walker. Default: false |
| `maxChars` | `number?` | Max output characters. 0 = no limit. Default: auto (~2500) |

#### Dispatch Logic

```
if text === true:
    Run DOM walker via plugin.evaluate(taskId, EXTRACTOR_SCRIPT)
    Cross-reference output with element cache for @e ref annotations
    Apply role/name/ref/subtree filters if provided
    Apply maxChars truncation
    Return structured text output

else if role || name || ref || subtree:
    Query in-memory element cache (synchronous)
    Apply filters
    Return element list with @e refs

else:
    Return summary of what's available
```

#### Element Query Output

```
Found 3 buttons:
  @e2 🔘 button "Reject All"
  @e3 🔘 button "Accept All"
  @e12 🔘 button "Subscribe for more"
```

#### Text Extraction Output

```
Title: How to Build a Compiler

Headings:
  📌 "How to Build a Compiler" [1]
  📌 "Lexical Analysis" [2]
  📌 "Parsing" [2]

Content:
  By Jane Doe · June 2026

  Compilers are programs that translate source code into machine code.
  The process involves several stages: lexical analysis, parsing,
  semantic analysis, optimization, and code generation.

Interactive:
  @e1 🔗 link "Lexical Analysis"
  @e2 🔗 link "Parsing"
  @e3 🔘 button "Subscribe for more"
```

Note the `@e` refs in the text output — that's the correlation. The agent reads "Lexical Analysis" and immediately sees `@e1` to click it.

#### @e Ref Correlation

After the DOM walker returns its structured data, the router cross-references it against the plugin's element cache:

1. For each extracted link/button/heading, check if an `AriaCachedNode` exists with matching `role` + `name`
2. If a match is found, annotate the text output with the `@e` ref
3. For non-interactive text (paragraphs, body copy), check if the text is a child/sibling of an interactive element in the cache, and annotate with the nearest parent/sibling `@e` ref

This is fuzzy matching — it works best on well-structured pages where `aria-label` and visible text align. It can miss on custom widgets or dynamically generated names. ~80-90% accuracy on typical pages, which is a vast improvement over zero.

The correlation logic lives in `core/shared/dom-extractor.ts` as a pure function: `correlateElements(extracted, elementCache) → AnnotatedExtractResult`. Testable without a browser.

### Feature C: `maxChars` Parameter

**Source:** v2 Phase 3 + web-guides-proposal, unified under P5.

Add `maxChars` to `browser-navigate`, `browser-snapshot`, and `browser-inspect`. Applied as router post-processing after `compactSnapshot()`, not inside it.

The `full` parameter on `browser-snapshot` is deprecated. `maxChars=0` replaces `full=true`. Both continue to work during a deprecation period, with `maxChars` taking precedence if both are set.

### Feature D: `web-guide` Tool + Auto-Hint

**Source:** web-guides-proposal, unchanged.

On-demand site-specific navigation guidance via `web-guide` tool. When the agent navigates to a URL that has a guide, a one-line auto-hint is appended to the navigate result.

Independent of Features A-C. Can be implemented in parallel. No architectural conflicts.

---

## 4. Plugin Interface Changes

### `getElementCache(taskId: string): Map<string, AriaCachedNode>` — Add to interface

Each plugin owns its element cache. The router needs access for `browser-inspect` element queries. This is the only new interface method.

### `getText()` — NOT added

The DOM extractor runs via the existing `evaluate()` method. The extractor JS string lives in `core/shared/dom-extractor.ts` and is passed to `plugin.evaluate(taskId, EXTRACTOR_SCRIPT)` from the router. No interface change needed.

### Python Parity

For `getElementCache()`: The Python bridge already maintains `element_caches` in the subprocess. Two changes:
1. Include serialized `elements` dict in navigate/snapshot responses (populates the TypeScript adapter's local cache)
2. Add `browser.getElementCache` JSON-RPC method for on-demand refresh

For the DOM extractor: No Python bridge changes. The extractor JS string runs via `page.evaluate()` in both backends identically.

---

## 5. DOM Walker Design

The extractor script runs in the page's JS context via `page.evaluate()`. It reads DOM properties only — no `fetch`, no `XMLHttpRequest`, no `eval`, no cookie/localStorage access. Safe by construction.

### Extracted Content

| Content | How | Notes |
|---------|-----|-------|
| Page title | `document.title` | Always included |
| Headings | `querySelectorAll('h1..h6')` | With level hierarchy |
| Paragraphs | `querySelectorAll('p, li, td, blockquote')` | Visible only, >5 chars (not 20), with blocklist for boilerplate |
| Links | `querySelectorAll('a[href]')` | With text + href |
| Images | `querySelectorAll('img[alt]')` | Alt text + src (not in original dom-extractor) |
| Interactive | `querySelectorAll('button, [role="button"], input, select, textarea')` | With label, type, disabled state |

### Boilerplate Filtering

Replace the dom-extractor's 20-char minimum (which missed short meaningful text like "Read more") with a blocklist approach:

- Skip elements whose text matches common boilerplate patterns: copyright notices, "All rights reserved", "Terms of Service", "Privacy Policy" when in footer/contentinfo regions
- Minimum length of 5 characters (not 20) to capture short actionable text
- The blocklist lives as a small array of regex patterns in `dom-extractor.ts`

### Truncation

Each text item is capped at 300 characters. The total output is capped by `maxChars` (router post-processing). If the agent needs more, it can use `maxChars=0` or read the disk cache for the full ARIA tree context.

---

## 6. Subtree Queries

The `subtree` parameter scopes results to elements inside a container role (e.g. `subtree="dialog"` returns only elements inside dialogs).

### Depth-Based Approximation

The initial implementation uses depth-based approximation from v2:
1. Find all elements matching the subtree role
2. Include those root elements AND all elements with greater depth
3. For text mode, the DOM walker can do exact subtree scoping (it walks the real DOM)

### Testing Gate

Before this feature is considered stable, test on 5-10 real-world pages with multiple same-role containers (e.g. two dialogs, nested navigations). If depth-based approximation fails on real pages, add `parentRef` to `AriaCachedNode` and implement exact subtree queries. This requires changes to both `accessibility-tree.ts` and the Python `accessibility.py` parser.

---

## 7. Freshness and Staleness

| Scenario | Element cache freshness | Text extraction freshness |
|----------|----------------------|--------------------------|
| After `navigate` or `snapshot` | Fresh (populated from response) | N/A (only runs on demand) |
| After `click`/`type` that navigates | Stale (URL changed, no new snapshot) | Fresh (runs live when called) |
| After `click`/`type` same page | May be stale (SPA mutations) | Fresh |
| After `scroll` | Stale (new elements may have loaded) | Fresh |

The cache notice on snapshots includes the fingerprint so the agent can detect staleness. For element queries after interactions, the agent should take a fresh snapshot first if it's unsure. This is documented in the tool description.

For Python plugins specifically, the adapter's local element cache is populated from navigate/snapshot responses. After interactions, it may be stale. The `browser.getElementCache` RPC method exists for on-demand refresh, and the router calls it before element queries when the Python adapter is in use.

---

## 8. File Changes

| File | Changes | Phase |
|------|---------|-------|
| `core/shared/snapshot-cache.ts` | **New** — disk cache logic, formatCacheNotice, cleanup | A |
| `core/shared/dom-extractor.ts` | **New** — extractor JS string, TS wrapper, correlation logic, boilerplate blocklist | B |
| `core/shared/accessibility-tree.ts` | Export `roleIcon()` | B |
| `core/plugin-api.ts` | Add `getElementCache(taskId)` to `BrowserPlugin` interface | B |
| `core/router.ts` | Disk cache wiring, browser-inspect dispatch, maxChars post-processing | A-C |
| `core/shared/session-manager.ts` | Snapshot file cleanup on session removal | A |
| `backends/chromium/index.ts` | Make `getElementCache()` public | B |
| `backends/python-adapter.ts` | Local element cache + getElementCache + _fetchElementCache | B |
| `backends/python-base/.../bridge.py` | `browser.getElementCache` RPC + elements in responses | B |
| `index.ts` | Register browser-inspect + web-guide, add maxChars params, deprecate `full` | B-D |
| `__tests__/snapshot-cache.test.ts` | **New** — temp file creation, cleanup, error handling | A |
| `__tests__/browser-inspect.test.ts` | **New** — element query, text extraction, correlation, subtree | B |
| `AGENTS.md` | Document new tools, disk caching, maxChars | ongoing |

---

## 9. Implementation Order

### Phase 1: Disk Cache (Feature A)

The highest-priority change — eliminates information loss entirely with no new tools or parameters.

1. Create `core/shared/snapshot-cache.ts`
2. Wire into router's `navigate()`, `snapshot()`, `compactInteractionResult()`
3. Wire cleanup into session manager
4. Update `index.ts` — keep safety-net cap with explanatory comment
5. Tests

### Phase 2: `browser-inspect` (Feature B)

Builds on the element cache access pattern. Replaces the separate `browser-query` + `browser-get-text` proposals.

1. Create `core/shared/dom-extractor.ts` — extractor script + correlation + blocklist
2. Export `roleIcon()` from `accessibility-tree.ts`
3. Add `getElementCache()` to `BrowserPlugin` interface
4. Make `ChromiumPlugin.getElementCache()` public
5. Python parity — elements in responses + RPC method + adapter local cache
6. Create `browser-inspect` tool in `index.ts` — merged element query + text extraction
7. Test subtree depth approximation on real pages
8. Tests

### Phase 3: `maxChars` (Feature C)

Trivial once the disk cache infrastructure exists.

1. Add `maxChars` param to `browser-navigate`, `browser-snapshot`, `browser-inspect`
2. Router post-processing after `compactSnapshot()`
3. Deprecate `full` parameter
4. Update cache notice and hint text
5. Tests

### Phase 4: `web-guide` (Feature D)

Independent — can be done in parallel with Phase 2 or 3.

1. Define `web-guide` tool in `index.ts`
2. Create initial guide content (cookie-consent, pagination, search, reddit, github)
3. Add `DOMAIN_MAP` and auto-hint injection in navigate output
4. Tests

---

## 10. What Does NOT Change

| Layer | Why It Stays |
|-------|-------------|
| `extractDialogBlocks()` | Dialog visibility detection in truncated snapshots. Orthogonal. |
| Snapshot fingerprint mechanism | Detects SPA transitions. Caching uses fingerprints in notices, doesn't change the mechanism. |
| `browser_finetuning.md` | Occlusion/dialog methodology. Institutional knowledge. |
| `checkOcclusion()` | Runtime occlusion detection. Orthogonal. |
| `verifyClick` fallback | Runtime safety net. Orthogonal. |
| `url-safety.ts` | Security boundary. Never knowledge-driven. |
| `bot-detection.ts` | Bot detection. Bot-detected snapshots are never cached. |
| `compactSnapshot()` signature | Stays pure — `(snapshot, elementCount) → string`. |
| `buildLocator()` | Maps @e refs to Playwright locators. Unchanged. |
| 13 core `BrowserPlugin` operations | Unchanged — `getElementCache()` is additive. |
| Python `parse_snapshot()` | No changes — parser and AriaCachedNode shape are identical. |
| `parseSnapshot()` internal logic | No changes — correlation and text extraction are external layers. |

---

## 11. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Stale cached file after SPA mutation | Medium | Cache notice includes fingerprint + scoped validity warning. Agent should re-snapshot after mutations. |
| @e ref correlation is fuzzy (~80-90%) | Medium | Better than zero correlation. Agent can always fall back to querying the element cache by name. Document the limitation. |
| Subtree depth-based approximation | Low-Med | Test on real pages before Phase 2 is considered stable. Add `parentRef` if depth-based fails. |
| Disk I/O exceptions | Low | Try-catch in `cacheSnapshot()` — graceful degradation to inline only. |
| Element cache stale after interactions (Python adapter) | Low | `_fetchElementCache()` async refresh called by router before element queries. |
| Temp file accumulation | Low | Per-task tracking, MAX_FILES_PER_TASK=2, cleanup on session removal. |
| Schema cost of `browser-inspect` + `web-guide` | Low | ~250-300 tokens/turn combined. `/web off` toggle exists as escape valve. Far cheaper than loading full snapshots (15-25KB). |
| DOM extractor returns minimal content on Cloudflare pages | Low | Consistent with bot detection signal. Agent sees little text, which correctly indicates the page is blocked. |
| `maxChars=0` convention is unfamiliar | Low | Parameter description explicitly states meaning. Agents that struggle can still use `full=true` during deprecation. |

---

## 12. Example Workflows

### Before (Current)

Agent visits Reddit, sees 5 of 87 elements in compact snapshot. Wants to click "Submit a new post" but it's past the truncation boundary.

```
Agent: browser-snapshot full=true     → 15KB into context
Agent: (scans 15KB of text, finds @e42)
Agent: browser-click ref="@e42"
```

Cost: ~15,000 tokens of snapshot context.

### After — Disk Cache + Element Query

```
Agent: browser-navigate "reddit.com"  → compact snapshot + cache notice + fingerprint
Agent: browser-inspect role="link" name="submit"
       → Found 1 element:
           @e42 🔗 link "Submit a new post"
Agent: browser-click ref="@e42"
```

Cost: ~2,500 tokens inline + ~100 tokens query result.

### After — Text Extraction with Correlation

```
Agent: browser-navigate "reddit.com"  → compact snapshot + cache notice
Agent: browser-inspect text=true maxChars=1500
       → Title: reddit.com
          Headings:
            📌 "Reddit" [1]
          Content:
            Popular posts: ...
          Interactive:
            @e5 🔗 link "Post Title 1"
            @e42 🔗 link "Submit a new post"
            @e3 🔘 button "Reject All"
Agent: browser-click ref="@e42"
```

Cost: ~2,500 tokens inline + ~1,500 tokens text extraction.

### After — Dialog Discovery

```
Agent: browser-navigate "reddit.com"  → compact snapshot + cache notice
Agent: browser-inspect role="button" subtree="dialog"
       → Found 2 elements:
           @e2 🔘 button "Reject All"
           @e3 🔘 button "Accept All"
Agent: browser-click ref="@e2"
Agent: browser-snapshot              → fresh compact snapshot
```

Cost: ~5,100 tokens total. No full snapshots needed.

### After — Reading an Article

```
Agent: browser-navigate "example.com/article"  → compact snapshot
Agent: browser-inspect text=true
       → Title: How to Build a Compiler
          Headings:
            📌 "How to Build a Compiler" [1]
            📌 "Lexical Analysis" [2]
          Content:
            Compilers are programs that translate source code into
            machine code. The process involves several stages...
          Interactive:
            @e1 🔗 link "Lexical Analysis"
            @e2 🔗 link "Parsing"
Agent: browser-click ref="@e1"         → navigates to section
```

Cost: ~2,500 + ~1,500 = ~4,000 tokens. The agent reads the article AND knows what it can click.

---

## 13. Superseded Documents

Once this plan is approved:

| Document | Status |
|----------|--------|
| `snapshot-cache-query-plan.md` | Archived — v1 draft |
| `snapshot-cache-query-plan-v2.md` | Superseded by this document |
| `dom-extractor.md` | Superseded by this document |
| `oracle-dom-extractor.md` | Reference only — recommendations incorporated |
| `web-guides-proposal.md` | Partially superseded — `maxChars` section replaced; `web-guide` tool section still authoritative |

Keep `web-guides-proposal.md` as the authoritative reference for guide content, `DOMAIN_MAP`, and auto-hint mechanics. The `maxChars` section (§5) is superseded by this document's Feature C.
