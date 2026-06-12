# Browser Intelligence Plan

> Date: 2026-06-12
> Status: **Reviewed** — oracle review incorporated (P2, P6, §3A, §6, §7, §11 updated)
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

**Complexity note.** The router (`core/router.ts`) is currently ~370 lines. After Features A–C it will likely reach 600–700 lines. This is manageable — the router already handles session lifecycle, truncation, bot-detection downgrade, auto-recovery, and stale @e ref handling — but the added logic (disk caching, maxChars post-processing, element query dispatch, text extraction dispatch, @e ref correlation) concentrates a lot of concern in one file. Consider extracting `browser-inspect` dispatch into its own module (`core/shared/inspect-dispatch.ts`) if the router exceeds ~650 lines.

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

**Duplicate role+name handling.** When multiple elements share the same role+name (e.g., three "Submit" buttons), the DOM walker cannot distinguish which instance maps to `@e5` vs `@e12` vs `@e23` based on role+name alone. In this case, correlate all matching elements to **every** matching `@e` ref and annotate with all candidates: `@e5, @e12, @e23 🔘 button "Submit"`. The agent can disambiguate by position or by reading the cached full snapshot. Document this limitation explicitly in the `browser-inspect` tool description.

**Stale cache after SPA mutations.** When `text=true` runs after a click that triggered an SPA mutation, the DOM walker returns live content but the element cache may be stale. The text content is fresh, but @e ref annotations derived from a stale cache can be wrong. When the router detects a potentially stale cache (last snapshot predates the last interaction), it appends a staleness notice to the `browser-inspect` output: `⚠ Element refs may be stale — consider browser-snapshot before clicking.`

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
- **Cache before compacting.** The router saves `result.snapshot` to a local variable before calling `compactInteractionResult()` so the raw (un-truncated) snapshot is available for caching. This applies to all interaction results (click, type, press, scroll) that navigate to a new page — the raw snapshot is captured at the compaction boundary, not after.
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

#### Tool Description and `promptGuidelines`

The `browser-inspect` tool definition in `index.ts` must include agent-facing guidance. Following the existing pattern (all tools have `description`, `promptSnippet`, `promptGuidelines`):

- **`description`**: "Query the current page for specific elements or extract readable text content. Use for targeted discovery instead of full snapshots."
- **`promptGuidelines`** should instruct the agent:
  - Use `browser-inspect role=... name=...` to find a specific element without loading a full snapshot
  - Use `browser-inspect text=true` to read page content (article, form, etc.) with correlated @e refs
  - Use `browser-inspect subtree=...` to scope queries inside dialogs, menus, or navigation regions
  - After clicking or scrolling, take a fresh `browser-snapshot` before trusting @e refs from `browser-inspect`
  - Do NOT use `browser-inspect` as a replacement for `browser-navigate` — it requires an existing session
  - When `browser-inspect` returns multiple @e refs for the same name, disambiguate by reading the cached full snapshot

This matters because the LLM defaults to `browser-snapshot full=true` when it doesn't know a better tool exists — the guidelines steer it toward the cheaper path.

#### @e Ref Correlation

After the DOM walker returns its structured data, the router cross-references it against the plugin's element cache:

1. For each extracted link/button/heading, check if an `AriaCachedNode` exists with matching `role` + `name`
2. If a single match is found, annotate the text output with the `@e` ref
3. **If multiple elements match the same role+name** (e.g., three "Submit" buttons), annotate with **all** matching `@e` refs: `@e5, @e12, @e23 🔘 button "Submit"`. The agent can disambiguate by position or by reading the cached full snapshot
4. For non-interactive text (paragraphs, body copy), check if the text is a child/sibling of an interactive element in the cache, and annotate with the nearest parent/sibling `@e` ref
5. **If the element cache is potentially stale** (last snapshot predates the last interaction), append a staleness notice: `⚠ Element refs may be stale — consider browser-snapshot before clicking.`

This is fuzzy matching — it works best on well-structured pages where `aria-label` and visible text align. It can miss on custom widgets or dynamically generated names. ~80-90% accuracy on typical pages, which is a vast improvement over zero.

The correlation logic lives in `core/shared/dom-extractor.ts` as a pure function: `correlateElements(extracted, elementCache, cacheFresh: boolean) → AnnotatedExtractResult`. The `cacheFresh` flag controls whether the staleness notice is appended. Testable without a browser.

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

For `getElementCache()`: The Python bridge already maintains `element_caches` in the subprocess. Three changes:
1. Include serialized `elements` dict in navigate/snapshot responses (populates the TypeScript adapter's local cache)
2. Add `browser.getElementCache` JSON-RPC method for on-demand refresh
3. Add `parentRef` field to the Python `accessibility.py` parser output so subtree queries work exactly (same change as TypeScript side)

This is more coordination than a simple method addition — it requires JSON-RPC protocol changes, the adapter's local cache implementation, and the parser change. Scope it as a full sub-task of Phase 2.

For the DOM extractor: No Python bridge changes. The extractor JS runs via `page.evaluate()` in both backends identically.

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

### `ExtractResult` Type Contract

The extractor returns a structured result matching this TypeScript interface:

```ts
interface ExtractResult {
  title: string;
  headings: { level: number; text: string }[];
  paragraphs: { text: string; region?: string }[];
  links: { text: string; href: string }[];
  images: { alt: string; src: string }[];
  interactive: { text: string; role: string; type?: string; disabled: boolean }[];
}
```

This contract is enforced in the correlation logic and in `__tests__/browser-inspect.test.ts`.

### Script Storage

The extractor script lives as a separate file (`core/shared/dom-extractor-script.js`) rather than an inline TypeScript string. It is read at runtime via `fs.readFileSync()` and passed to `plugin.evaluate(taskId, extractorScript)`. This enables:
- Syntax checking by the TypeScript compiler and any JS linter
- Easier debugging — the script can be tested standalone
- Independent versioning from the correlation wrapper

### Error Handling

When `page.evaluate()` throws or returns non-structured data:
- The router catches the error and returns a clear message: `Text extraction failed: <error>. The page may have strict CSP or the DOM may have changed.`
- This is distinct from a missing session error (handled by `requireInteractiveSession()`)
- The `supportsJavaScriptEvaluate` capability (always `true` for Chromium and Python backends) is checked before dispatch — if a future backend doesn't support it, the router returns: `Text extraction is not supported by this backend.`

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

### `parentRef` in `AriaCachedNode` (from the start)

Rather than shipping a depth-based approximation and later migrating to exact parent tracking, add `parentRef: string?` to `AriaCachedNode` from Phase 2. This is cheap incremental work — `parseSnapshot()` in `accessibility-tree.ts` already has the parent stack available during its second pass, so populating `parentRef` requires a single field addition per node. The Python `accessibility.py` parser gets the same change.

With `parentRef` available, subtree queries work exactly:
1. Find all elements matching the subtree role (e.g., all `dialog` roots)
2. Recursively collect descendants by following `parentRef` pointers from every cached node back to the subtree root
3. For text mode, the DOM walker can do exact subtree scoping (it walks the real DOM)

This avoids shipping a depth-based approximation that is known to fail on pages with nested same-role containers (e.g., two `<nav>` elements where one is inside the other).

---

## 7. Freshness and Staleness

| Scenario | Element cache freshness | Text extraction freshness | Correlation accuracy |
|----------|----------------------|--------------------------|----------------------|
| After `navigate` or `snapshot` | Fresh (populated from response) | N/A (only runs on demand) | Accurate |
| After `click`/`type` that navigates | Stale (URL changed, no new snapshot) | Fresh (runs live when called) | **Wrong** — live DOM + stale cache |
| After `click`/`type` same page | May be stale (SPA mutations) | Fresh | **May be wrong** — stale @e refs on fresh text |
| After `scroll` | Stale (new elements may have loaded) | Fresh | **May be wrong** — missing refs for new elements |

The cache notice on snapshots includes the fingerprint so the agent can detect staleness. For element queries after interactions, the agent should take a fresh snapshot first if it's unsure. This is documented in the tool description.

**Correlation staleness indicator.** When the router detects that the element cache predates the last interaction, it sets `cacheFresh: false` when calling `correlateElements()`, which appends a staleness notice to the `browser-inspect` output. The agent can then decide to take a fresh snapshot before clicking.

For Python plugins specifically, the adapter's local element cache is populated from navigate/snapshot responses. After interactions, it may be stale. The `browser.getElementCache` RPC method exists for on-demand refresh, and the router calls it before element queries when the Python adapter is in use.

---

## 8. File Changes

| File | Changes | Phase |
|------|---------|-------|
| `core/shared/snapshot-cache.ts` | **New** — disk cache logic, formatCacheNotice, cleanup | A |
| `core/shared/dom-extractor.ts` | **New** — TS wrapper, correlation logic, boilerplate blocklist, `ExtractResult` interface | B |
| `core/shared/dom-extractor-script.js` | **New** — the extractor JS script, read at runtime via `fs.readFileSync()` | B |
| `core/shared/accessibility-tree.ts` | Export `roleIcon()`; add `parentRef` to `AriaCachedNode` | B |
| `core/plugin-api.ts` | Add `getElementCache(taskId)` to `BrowserPlugin` interface; add `supportsJavaScriptEvaluate` capability | B |
| `core/router.ts` | Disk cache wiring (cache before compact), browser-inspect dispatch, maxChars post-processing | A-C |
| `core/shared/session-manager.ts` | Snapshot file cleanup on session removal | A |
| `backends/chromium/index.ts` | Make `getElementCache()` public; set `supportsJavaScriptEvaluate: true` | B |
| `backends/python-adapter.ts` | Local element cache + getElementCache + _fetchElementCache | B |
| `backends/python-base/.../bridge.py` | `browser.getElementCache` RPC + elements in responses + `parentRef` field | B |
| `backends/python-adapter.ts` | Set `supportsJavaScriptEvaluate: true` | B |
| `index.ts` | Register browser-inspect + web-guide, add maxChars params, deprecate `full`, add error paths | B-D |
| `__tests__/snapshot-cache.test.ts` | **New** — temp file creation, cleanup, error handling | A |
| `__tests__/browser-inspect.test.ts` | **New** — element query, text extraction, correlation, subtree, duplicate role+name, staleness | B |
| `AGENTS.md` | Document new tools, disk caching, maxChars, correlation limits | ongoing |

---

## 9. Implementation Order

### Phase 1: Disk Cache (Feature A)

The highest-priority change — eliminates information loss entirely with no new tools or parameters.

1. Create `core/shared/snapshot-cache.ts`
2. Wire into router's `navigate()`, `snapshot()` — cache the raw snapshot **before** calling `compactInteractionResult()` so the untruncated tree is available
3. Wire into `compactInteractionResult()` — save `result.snapshot` to a local variable before compacting, then pass it to `cacheSnapshot()`
4. Wire cleanup into session manager
5. Update `index.ts` — keep safety-net cap with explanatory comment
6. Tests

### Phase 2: `browser-inspect` (Feature B)

Builds on the element cache access pattern. Replaces the separate `browser-query` + `browser-get-text` proposals.

1. Create `core/shared/dom-extractor.ts` — TS wrapper, correlation logic, `ExtractResult` interface, boilerplate blocklist
2. Create `core/shared/dom-extractor-script.js` — the extractor JS script (separate file, read at runtime)
3. Export `roleIcon()` from `accessibility-tree.ts`
4. Add `parentRef` to `AriaCachedNode` in `accessibility-tree.ts` and Python `accessibility.py` parser
5. Add `getElementCache()` to `BrowserPlugin` interface; add `supportsJavaScriptEvaluate` capability
6. Make `ChromiumPlugin.getElementCache()` public; set `supportsJavaScriptEvaluate: true`
7. Python parity — elements in responses + RPC method + adapter local cache + `parentRef` field (full sub-task with JSON-RPC protocol changes)
8. Create `browser-inspect` tool in `index.ts` — merged element query + text extraction + error paths (no session, evaluate failure, stale cache notice)
9. Tests (include duplicate role+name and staleness scenarios)

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
| `parseSnapshot()` core logic | Unchanged — `parentRef` is an additive field (populated from existing parent stack). Correlation and text extraction are external layers. |

---

## 11. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Stale cached file after SPA mutation | Medium | Cache notice includes fingerprint + scoped validity warning. Agent should re-snapshot after mutations. |
| @e ref correlation is fuzzy (~80-90%) | Medium | Better than zero correlation. Agent can always fall back to querying the element cache by name. Document the limitation. |
| **@e ref correlation wrong after SPA mutations** | **Medium** | Staleness indicator appended to `browser-inspect` output when cache predates last interaction. Agent can take fresh snapshot before clicking. |
| **@e ref correlation on duplicate role+name** | **Medium** | All matching @e refs are annotated (e.g., `@e5, @e12, @e23`). Agent disambiguates by position or reads cached full snapshot. Documented in tool description. |
| **`page.evaluate()` throws on strict CSP** | Low | Playwright bypasses CSP (DevTools-level injection). Document that `supportsJavaScriptEvaluate: true` is required. Future backends without eval support get clear error. |
| **Element cache size on complex pages (O(n·m) correlation)** | Low | Bounded by `maxElements` (default 500). Acceptable in practice. |
| **DOM extractor returns non-structured data** | Low | Router catches error, returns clear message. Falls back to element-only query. |
| **Race between cache write and agent read** | Low | MAX_FILES_PER_TASK=2 with timestamped filenames mitigates. Rapid 3+ snapshots lose older files — acceptable trade-off. |
| **`full=true` + `maxChars=N` conflict** | Low | `maxChars` takes precedence. Explicitly handled in execute function with early return. |
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
