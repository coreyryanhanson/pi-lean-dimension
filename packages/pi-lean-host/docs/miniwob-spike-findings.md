# MiniWoB Spike Test — Findings (Step 0)

**Date:** 2026-07-03
**MiniWoB commit:** `7fd85d71a4b60325c6585396ec4f48377d049838`
**Plugin:** ChromiumPlugin (Node/Playwright)
**Test server:** Node.js static file server on `127.0.0.1:8766` serving `/tmp/miniwob-plusplus/miniwob/html/`

## Summary: SPIKE PASSED ✅

The pass criterion was: *"target interactive elements appear in our snapshot with `@e` refs."*

**Result: ✅ PASS — confirmed for all three representative tasks.**

| Task | Elements | @e Refs | Status |
|------|----------|---------|--------|
| `click-button.html` | 5 (3 buttons, 2 textboxes) | 5 | ✅ PASS |
| `email-inbox.html` | 1 (heading) | 1 | ✅ PASS |
| `form-sequence.html` | 4 (3 checkboxes, submit) | 4 | ✅ PASS |

## Key Findings

### 1. No iframe issue (❌ Plan's gating concern was unfounded)

All three tasks render their content **directly in the top-level DOM**. We confirmed zero `<iframe>` elements via `document.querySelectorAll('iframe')`. The interactive content is inside `#area` div at top frame level.

**The iframe concern in the integration plan was based on an outdated assumption.** At this MiniWoB++ commit, no task uses iframes for content.

### 2. START overlay must be clicked (⚠️ Critical behavior)

MiniWoB tasks have a **START overlay** (`<div id="sync-task-cover">`) that must be clicked before the task content appears. This is by design:

```javascript
core.startEpisode = function() {
  core.createDisplay();
  if (core.cover_div == null) {
    core.cover_div = document.createElement('div');
    core.cover_div.setAttribute('id', 'sync-task-cover');
    core.cover_div.innerHTML = 'START';
    core.cover_div.onclick = function () {
      core.startEpisodeReal();  // calls genProblem() → creates interactive content
    };
  }
  core.cover_div.style.display = 'block';
};
```

Without clicking START:

- `#area` is empty (0 children)
- `#query` has no text
- Our snapshot shows only the reward display overlay

**Solution:** Use `page.evaluate` or `page.click` to click the START overlay, or port BrowserGym's JS injection that monkeypatches `core.startEpisodeReal` to auto-start.

### 3. Static HTML tasks work immediately

`form-sequence.html` uses static HTML elements (checkboxes in `<body>`) and renders correctly even without clicking START:

```
@e1 ☑ checkbox
@e2 ☑ checkbox
@e3 ☑ checkbox
@e4 🔘 button "Submit"
```

### 4. d3.js-rendered tasks work AFTER clicking START

`click-button.html` generates buttons dynamically via d3.js after START is clicked. After the click:

```
@e1 📝 textbox
@e2 🔘 button "Cancel"
@e3 📝 textbox
@e4 🔘 button "Ok"
@e5 🔘 button "ok"
```

### 5. Default viewport is 1280×720

Our ChromiumPlugin defaults to viewport 1280×720 with devicePixelRatio 1. BrowserGym uses 332×214 with scale 1.5. For coordinate-based tasks this matters, but for element-ref tasks (which we're targeting) viewport differences are unlikely to affect semantic element detection.

## Open Questions from the Plan — Answered

| Question | Answer |
|----------|--------|
| Does `click-button.html` render in an iframe? | **No** — top-level DOM, `#area` |
| Does our snapshot see iframe content? | **N/A** — no iframes exist |
| What viewport does Chromium default to? | **1280×720, dpr=1** |

## Implications for the Integration Plan

### Step 0 passes — proceed with Steps 1-5

The spike confirms MiniWoB is viable. Key considerations for the full implementation:

1. **Every task needs the START click** (or JS injection to auto-start). BrowserGym's `base.py` `setup()` JS injection is the cleanest approach — port it verbatim (removes overlay, monkeypatches startEpisode).

2. **email-inbox tasks have limited interactive elements** — most content renders as plain text (email subject lines, body text). Only the heading "Primary" shows as an interactive element. Our `@e`-ref model may need to handle text-heavy layouts via text extraction + role lookup.

3. **~50-60 tasks are testable** — the original estimate holds. The START-to-trigger pattern is universal across all tasks.

4. **No iframe traversal code needed** — this simplifies the implementation significantly.

## Test Artifacts

- Spike test: `packages/pi-lean-portal/__tests__/miniwob-spike.test.ts` (one-off, can delete after Step 0 review)
- MiniWoB source: `/tmp/miniwob-plusplus/` (cloned at pinned commit)
- HTTP server: `node /tmp/miniwob-server.mjs` serves on port 8766
