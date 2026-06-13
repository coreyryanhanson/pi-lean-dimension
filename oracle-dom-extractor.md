# Oracle Review: DOM Text Extraction for pi-browser

**Reviewer:** Oracle (decision-consistency subagent)  
**Date:** 2026-06-12  
**Target:** `/root/.pi/agent/extensions/pi-browser/dom-extractor.md` (Proposed)

---

## 1. Viability

### Verdict: Sound and well-scoped. This is more implementable than the skills proposal.

The document identifies a genuine gap (Section 1 — "browsing blindfolded with a clicker in hand") and proposes a clean, minimal solution. The extractor script is ~50 lines of straightforward DOM walking that works identically in both backends (TypeScript `page.evaluate()` and Python `page.evaluate()`). No new framework patterns are needed.

**What makes this viable:**
- **No new plugin methods required** — The `page.evaluate()` call already exists as a cross-backend primitive. The document proposes adding `getText()` to the `BrowserPlugin` interface (Section 7, step 5), but this could also be done purely in the router using existing `evaluate()` calls.
- **Self-contained** — The extractor JS string is a standalone function. No dependencies, no build step, no external packages.
- **Safe by construction** — The extractor reads DOM properties only (Section 6.4). No `fetch`, no `XMLHttpRequest`, no `eval`. It physically cannot exfiltrate data.
- **Cross-backend by design** — The same JS function runs in ChromiumPlugin and the Python bridge. The document explicitly calls this out in Section 2.2.

**Fragility points:**
- **The extractor runs after navigation** but before bot detection recovery (Section 6.3). A Cloudflare challenge page returning minimal text is "consistent with the bot detection signal" — but it's also *indistinguishable* from a legitimate sparse page. The agent would need to distinguish "this page is minimal because it's blocked" from "this page is minimal because it's simple." The document hand-waves this.

---

## 2. Pitfalls

### 2.1 The Hybrid Recommendation (Section 3.3) Adds Complexity

The document recommends Option A (standalone tool) as default, with Option B (snapshot augmentation) as a configurable future mode. This is sensible, but the document spends too much time describing Option B. The two modes would need different truncation strategies, different `maxChars` handling, and potentially different session management paths. Recommending one and mentioning the other as future work would be cleaner.

### 2.2 Text Quality Issues Not Addressed

The extractor (Section 2.1) captures visible text with basic heuristics:

```javascript
if (text && text.length > 20) {  // Skip boilerplate
```

This threshold means:
- Short but meaningful text is lost ("Read more", "Buy now", "Submit", "Cancel"). These are often the most actionable elements.
- Boilerplate that happens to be >20 chars passes through (footer disclaimers, copyright notices, cookie banner text).
- The 300-char paragraph cap truncates long-form content mid-sentence.

The document acknowledges this as future work (Section 9) but doesn't give the agent any signal about *which* content was truncated. An agent reading "After the court ruling, the commission announced... [truncated]" has no way to know what it's missing.

### 2.3 Interaction with the Accessibility Tree Is Underspecified

Section 8 says the ARIA tree and DOM extractor are complementary — ARIA for interaction, DOM for reading. But in practice:
- **The agent gets two separate views of the same page.** It must mentally merge `@e42 🔗 link "Comment"` (from ARIA tree) with "Comments (42): User says..." (from DOM text). This mental merge is fragile and error-prone.
- **@e refs from ARIA tree don't map to DOM text.** The agent can see a "Read more" link in the DOM extractor but has no way to correlate it to an `@e` ref for clicking.
- **Without correlation, the agent may try to `browser-click @e5` to click a "Read more" link seen in the DOM extractor, but @e5 might be an unrelated element.** This disconnect is the document's biggest blind spot.

### 2.4 The Extractor Misses Key Content Types

| Content type | Missed by extractor | Impact |
|-------------|-------------------|--------|
| Images/alt text | Not captured (Section 9 future work) | Agent is blind to images entirely |
| Tables | Not captured (Section 9 future work) | Agent can't read tabular data |
| Code blocks | Captured as paragraphs | Formatting lost, language labels lost |
| Nested lists | Flattened | Hierarchy lost |
| Forms with labels | Captured as interactive, but label-for association not handled | Agent can see a textbox but not its label |

### 2.5 Token Cost Is Meaningful (and the Document Acknowledges It)

Section 5's token budget is honest:

| Scenario | ARIA only | ARIA + DOM text | Delta |
|----------|-----------|----------------|-------|
| Reddit feed | 2000 chars | 3500 chars | +1500 chars |

For the recommended Option A (standalone tool), this is pay-on-demand — zero cost when not called. The agent calls `browser-get-text` only when it needs to read. This is the right tradeoff.

For Option B (snapshot augmentation), every snapshot costs 50–75% more. The 2500-char compact snapshot becomes ~4000 chars. The document's recommendation (Option A) avoids this, but the mere presence of Option B in the document invites future scope creep toward always-on augmentation.

### 2.6 Section 7 Mistakes: Adding `getText` to the Plugin Interface

Step 5 says "Add `BrowserPlugin.getText` to interface in `plugin-api.ts`." This is architecturally questionable:

- **The extractor runs via `page.evaluate()`, which is already available through the existing `evaluate` method.** Adding a dedicated `getText` interface method with its own signature, error handling, and capabilities flag is over-engineering for what's essentially a pre-packaged `evaluate()` call.
- It couples the plugin interface to a specific client-side need. If next month someone wants a `getMetadata` tool (Open Graph tags, JSON-LD, meta description), do they add another interface method?
- **A better design:** Implement `browser-get-text` in the router layer using the existing `evaluate()` plugin method. The router calls `plugin.evaluate(taskId, extractorScript)`, parses the result, and runs it through `compactSnapshot`. Zero interface changes needed.

---

## 3. Merits

### 3.1 What It Genuinely Solves

- **The blind-interaction problem is real and well-articulated.** The concrete symptom table (Section 1) is excellent — "Reddit post: `@e5 🔗 link "More posts"` but agent can't see the post title." This is the strongest part of the document.
- **The "why this complements skills" section (Section 4) is insightful.** Skills say what to expect; extractor gives content to reason about. Together they're genuinely more valuable than either alone.
- **`page.evaluate()` is the right mechanism.** It's cross-backend, sandboxed, and already available.
- **The standalone tool approach (Option A)** is the correct default. Lazy, pay-on-demand, zero ongoing cost.
- **The token budget table (Section 5)** is honest about the cost tradeoffs.

### 3.2 What Stays Unsolved

- **@e ref ↔ text correlation.** The agent gets two parallel views of the page and must manually cross-reference them. This is error-prone and adds cognitive load.
- **Section-aware extraction.** The agent can't tell what content is visible vs. below the fold. Section 9 mentions this as future work.
- **Dynamic content.** The extractor captures a single moment. Infinite-scroll content, lazy-loaded sections, and SPA transitions aren't captured.
- **Accessibility tree improvements.** The more fundamental fix would be to improve `page.ariaSnapshot()` to include text content. The document doesn't entertain this possibility.

---

## 4. Recommendations

### 4.1 Don't Add `getText` to the Plugin Interface

Implement `browser-get-text` in the router using `plugin.evaluate(taskId, EXTRACTOR_SCRIPT)`. This keeps the plugin interface lean and avoids coupling it to a specific tool. If the extractor script is in `core/shared/dom-extractor.ts` (as Section 7, Step 1 proposes), the router can load it without the interface changing.

**Lines saved:** ~10 in `plugin-api.ts`, ~5 in `plugin-registry.ts` (no validation changes needed).

### 4.2 Add @e Ref Correlation

The most impactful improvement would be to annotate extracted text with `@e` refs from the accessibility tree. When the ARIA tree shows `@e42 🔗 link "Read more"` and the DOM extractor finds `"Read more about the new policy"`, the extractor should output `@e42: Read more about the new policy`. This bridges the agent's interaction and reading views.

**Implementation sketch:** After parsing the ARIA tree and DOM tree, match elements by `aria-label`, `textContent`, or position. This is fuzzy matching, but even 60% accuracy would be better than today's 0%.

### 4.3 Lower the Paragraph Threshold

The 20-char minimum (Section 2.1) is too aggressive. Lower to 5 characters. Boilerplate filtering should use blocklist patterns (copyright, "All rights reserved", "Terms of Service") rather than a character-length heuristic that also filters short-form content.

### 4.4 Add Alt-Text Capture

Images with `alt` text are a high-value low-effort addition. Add one query selector:

```javascript
document.querySelectorAll('img[alt]').forEach(img => {
  result.images.push({ alt: img.alt, src: img.src });
});
```

This adds ~5 lines and captures content the ARIA tree completely misses.

### 4.5 Cut Section 3.2 (Snapshot Augmentation / Option B) from the Document

Or relegate it to a footnote. It's the wrong default and will be a source of scope creep. Keep the document focused on Option A. When someone needs always-on mode, they can argue for it separately.

### 4.6 Clarify the Reddit Example in Section 4

The example shows:
```
3. browser-click @e42 → clicks the target post
```

After step 4 (`browser-get-text`), the agent sees post titles but has no `@e` ref for individual posts. The ARIA tree (step 1) would give `@e42` as a link/rowheader for the post title. The example implies correlation that doesn't exist yet. Either add correlation (Recommendation 4.2) or fix the example to show the agent using the ARIA tree for clicking.

---

## 5. Priority

### Recommendation: **Do now** — implement with the router-only approach.

| Factor | Assessment |
|--------|-----------|
| **Problem severity** | High. The agent is genuinely blind to page content. This is the most impactful improvement available. |
| **Implementation cost** | ~275 lines total (document's estimate). With the router-only simplification, ~200 lines. |
| **Risk level** | Low. The extractor is sandboxed JS. No new session management. No state changes. |
| **Testability** | High. Structural tests need no browser. Behavioral tests use existing infrastructure. |
| **Post-refactor timing** | Excellent. Plugin refactor is done. Adding a content layer on top is the natural next step. |
| **Dependencies** | None on the skills proposal. This is independent and should be implemented first. |

### Suggested Implementation Order

1. **Write the extractor script** in `core/shared/dom-extractor.ts` (~60 lines, as proposed).
2. **Implement `browser-get-text` in the router** using `plugin.evaluate()` — no interface changes. (~60 lines)
3. **Register the tool** in `index.ts` with `maxChars` parameter. (~40 lines)
4. **Add @e ref correlation** as a linking layer between ARIA tree and extracted text. (~80 lines)
5. **Write tests** — structural (result shape), behavioral (real page), and a cross-backend consistency test. (~60 lines)
6. **Write cross-cutting skills** (independent effort) to tell the agent *when* to call `browser-get-text`.

---

## Summary Table

| Aspect | Verdict |
|--------|---------|
| Problem is real | ✅ Yes, and well-articulated |
| Proposed mechanism works | ✅ Yes, sound |
| Plugin interface change needed? | ❌ No — implement in router via `evaluate()` |
| @e ref correlation missing? | ⚠️ Yes — biggest gap |
| Ready to implement? | ✅ Yes, with router-only simplification |
| Conflicts with skills proposal? | ❌ No — they complement each other |
| Risk | Low — sandboxed, stateless, no session changes |
| Priority | **High — implement now** |
