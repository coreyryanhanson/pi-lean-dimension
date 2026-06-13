# DOM Text Extraction for pi-browser

> Date: 2026-06-11
> Status: **Proposed** — complementary DOM-based text extraction alongside the
> ARIA accessibility tree, delivered as a new `browser-get-text` tool and an
> optional snapshot augmentation.

---

## 1. Problem

`page.ariaSnapshot()` is a testing utility designed for screen reader
assertions. It answers the question "where are the interactive elements?" but
not "what does this page say?" The agent has `@e` refs it can click, but zero
text content to understand what it's looking at.

The agent is browsing blindfolded with a clicker in hand.

### Concrete Symptoms

| Scenario | What the agent sees | What it can't see |
|----------|-------------------|-------------------|
| Reddit post | `@e5 🔗 link "More posts"` | The post title, body text, comment count |
| GitHub PR | `@e12 🔘 button "Review changes"` | The PR title, description, diff summary |
| Article page | `@e3 📝 textbox "Search"` | The article heading, paragraphs, metadata |

The `compactSnapshot()` truncation (2500 chars) further compounds the problem —
even the `@e` refs get cut off before the agent sees the content it cares about.

### Root Cause

`ariaSnapshot()` classifies `role="text"` and `role="paragraph"` as
"informational" — shown in the tree but never assigned `@e` refs. It's by
design. But the side effect is that the agent can interact without reading.

---

## 2. Solution: DOM Text Extraction

Run a JavaScript DOM walker via `page.evaluate()` to capture visible text
content, heading hierarchy, and element positions. This runs in **both**
backends (TypeScript and Python) using the same JavaScript code.

### 2.1 The Extractor Script

A ~50 line JavaScript function that walks the DOM and returns structured data:

```javascript
// extractPageTree.js — runs in page.evaluate()
function extractPageTree() {
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
    if (el.getAttribute('role') && ['button', 'link', 'menuitem', 'tab'].includes(el.getAttribute('role'))) return true;
    if (el.onclick || el.getAttribute('aria-haspopup')) return true;
    return false;
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  const result = {
    title: document.title || '',
    headings: [],
    paragraphs: [],
    links: [],
    interactive: [],
  };

  // Extract headings with hierarchy
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    if (isVisible(h)) {
      result.headings.push({
        level: parseInt(h.tagName[1]),
        text: h.innerText?.trim().slice(0, 200) || '',
      });
    }
  });

  // Extract meaningful paragraphs (filter out nav/footer boilerplate)
  document.querySelectorAll('p, li, td').forEach(p => {
    if (isVisible(p)) {
      const text = p.innerText?.trim();
      if (text && text.length > 20) {  // Skip boilerplate
        result.paragraphs.push(text.slice(0, 300));
      }
    }
  });

  // Extract links with text
  document.querySelectorAll('a[href]').forEach(a => {
    if (isVisible(a)) {
      const text = a.innerText?.trim().slice(0, 100) || '';
      if (text) {
        result.links.push({ text, href: a.href });
      }
    }
  });

  // Extract interactive elements (buttons, inputs) with labels
  document.querySelectorAll('button, [role="button"], input, select, textarea').forEach(el => {
    if (isVisible(el)) {
      const text = el.innerText?.trim().slice(0, 100) ||
                   el.getAttribute('aria-label') ||
                   el.getAttribute('placeholder') || '';
      if (text || el.type !== 'hidden') {
        result.interactive.push({
          tag: el.tagName.toLowerCase(),
          text,
          type: el.type || '',
          disabled: el.disabled,
        });
      }
    }
  });

  return result;
}
```

### 2.2 Cross-Language Invocation

**TypeScript backend** (`backends/chromium/index.ts`):

```typescript
const tree = await page.evaluate(extractPageTree);
```

**Python backend** (`backends/chromium-py/bridge.py`):

```python
tree = page.evaluate(extractPageTree)
```

Same JavaScript, same result, both backends.

---

## 3. Delivery Mechanisms

Two ways to surface the extracted text to the agent:

### 3.1 Option A: `browser-get-text` Tool (Standalone)

A new tool that returns the extracted text as readable Markdown:

```
browser-get-text {
  maxChars?: number  // Default: auto (~3000 chars)
}
```

Returns structured output:

```
Title: Hacker News Front Page

Headings:
  1. Hacker News

Links:
  - Show HN: My Project (42 comments)
  - Ask HN: How do you... (128 comments)
  - Launch HN: New SaaS... (5 comments)

Interactive:
  - button "More"
  - textbox "Search"
  - link "Guidelines"

Content:
  Post titles and descriptions...
```

**Pros:** Agent calls it explicitly when it needs to read. Lazy load — zero cost when not used.
**Cons:** Extra tool call overhead. Agent must remember to call it.

### 3.2 Option B: Snapshot Augmentation (Automatic)

Append extracted text to the existing snapshot output:

```typescript
// In router.ts compactSnapshot():
const ariaTree = parsed.text;          // Existing @e ref tree
const domText = domExtractToMarkdown(tree); // New text content
const merged = domText + '\n\n' + ariaTree;
return compactSnapshot(merged, elementCount);
```

**Pros:** Agent gets both reading and interaction in one call.
**Cons:** Always costs tokens even when the agent only needs clicking.

### 3.3 Recommended: Hybrid (A + configurable B)

- Default: `browser-get-text` as a standalone tool (Option A). Agent reads when it needs to.
- Skills can instruct: "After navigating to Reddit, call `browser-get-text` to read the post titles before interacting."
- Future: Add a config flag to enable snapshot augmentation (Option B) for users who want it always-on.

---

## 4. Why This Complements Skills

The skill-tool layer tells the agent *what to expect* on a site. The DOM
extractor gives it the *content to reason about*. Together:

```
1. Skill: "Reddit post titles appear in role='link' under role='table'."
2. Skill: "After navigating, use browser-get-text to read the feed before clicking."
3. Agent: browser-navigate "reddit.com"
4. Agent: browser-get-text → sees post titles, comment counts
5. Agent: browser-click @e42 → clicks the target post
```

The skill reduces exploratory calls. The extractor eliminates blind interaction.
Each makes the other more valuable.

---

## 5. Token Budget

| Scenario | ARIA only | ARIA + DOM text | Savings |
|----------|-----------|----------------|---------|
| Simple page (10 elements) | 300 chars | 800 chars | +500 |
| Content page (article) | 500 chars | 1500 chars | +1000 |
| Complex page (Reddit feed) | 2000 chars | 3500 chars | +1500 |

With `maxChars` (from web-guides-proposal.md), the agent controls the budget:

```
browser-get-text maxChars=500    → quick scan of headings + top links
browser-get-text maxChars=2000   → full reading view
browser-get-text maxChars=0      → everything (uncommon)
```

---

## 6. Integration with Existing Infrastructure

### 6.1 Truncation

The existing `compactSnapshot()` handles truncation. The DOM text would flow
through the same pipeline with its own `maxChars` parameter. No new truncation
logic needed.

### 6.2 Session Management

`browser-get-text` uses `requireInteractiveSession()` like all other tools.
No session changes needed.

### 6.3 Bot Detection

The `page.evaluate()` call happens *after* navigation (and after bot detection
checks). A Cloudflare challenge page would return minimal content — the agent
would see little text, which is consistent with the bot detection signal.

### 6.4 Safety

The extractor runs in the page's sandboxed JS context. It reads DOM properties
only — no `fetch`, no `XMLHttpRequest`, no `eval`. It cannot access cookies,
localStorage, or make network requests. It's safe.

---

## 7. Implementation Steps

1. **Write the extractor script** — `core/shared/dom-extractor.ts` containing
   the `extractPageTree` function as a string and a TS wrapper. (~60 lines)

2. **Add `browser-get-text` tool** to `index.ts` with `maxChars` parameter.
   (~80 lines)

3. **Wire into ChromiumPlugin** — add `getText(taskId): Promise<ExtractResult>`
   to `BrowserPlugin` interface. Implement in ChromiumPlugin. (~30 lines)

4. **Wire into Python bridge** — add `browser.getText` JSON-RPC method in
   `chromium-py/bridge.py`. The extractor JS string is shared. (~20 lines)

5. **Add `BrowserPlugin.getText` to interface** in `plugin-api.ts` and
   `validatePlugin` in `plugin-registry.ts`. (~10 lines)

6. **Router dispatch** — add `getText()` router function with session
   management and truncation. (~30 lines)

7. **Update skills** — `navigate-reddit` and `navigate-github` reference
   `browser-get-text` in their `promptGuidelines`. (~5 lines each)

8. **Add tests** — structural test (result shape), behavioral test (real
   page text extraction), contract test (both backends produce same text).
   (~40 lines)

### Total: ~275 lines across 6 files

---

## 8. What This Does NOT Replace

| Layer | Status | Why |
|-------|--------|-----|
| `ariaSnapshot()` | Keep | Role-based locators (`getByRole()`) are deterministic and available in both backends. Essential for click/type. |
| `parseSnapshot()` | Keep | Dialog prioritisation, @e ref assignment, occurrence tracking. The interaction layer. |
| `compactSnapshot()` | Keep | Truncation logic. Now receives merged content instead of ARIA-only. |
| `buildLocator()` | Keep | Maps `@e` refs to Playwright locators. Unchanged. |
| `checkOcclusion()` | Keep | Runtime visual occlusion detection. Still needed for overlays. |

The DOM extractor is an **addition**, not a replacement. The ARIA tree
handles interaction; the DOM tree handles reading. Together they give the
agent a complete picture.

---

## 9. Future Work

- **DOM extractor tuning** — Adjust the text thresholds (20 char minimum,
  300 char max per paragraph) based on agent usage patterns.
- **Section-aware extraction** — Use `IntersectionObserver` to detect which
  paragraphs are in the current viewport vs. scrolled away.
- **Image alt-text capture** — Extract `alt` and `aria-label` from images
  for richer context.
- **Table extraction** — Convert `<table>` elements to Markdown tables.
- **Snapshot augmentation mode** — Config option to always merge DOM text
  into the snapshot output (for users who don't want the extra tool call).
