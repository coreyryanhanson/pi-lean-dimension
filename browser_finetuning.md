# Browser Fine-Tuning Strategy

> Strategy for systematically evaluating, diagnosing, and hardening the
> browser plugin infrastructure — ensuring dialog interactions (and all
> element interactions) are reliable, deterministic, and maintainable.
>
> Target: both TypeScript (`backends/chromium/index.ts`) and Python
> (`backends/chromium-py/bridge.py`, `backends/python-base/pi_browser_bridge/`)
> backends.

---

## 1. Why This Document Exists

We've accumulated a significant number of fixes and enhancements across
multiple branches, each addressing real-world behavior observed on sites
like Reddit, The Guardian, Google, and W3Schools:

- **Occlusion detection** (`checkOcclusion` / `_check_occlusion`) — prevents
  clicking elements hidden behind overlays
- **Dialog-priority snapshotting** (`parseSnapshot` two-pass) — ensures
  dialog elements get @e refs even under the 500-element cap
- **Dialog-aware compaction** (`compactSnapshot` + `extractDialogBlocks`) —
  appends dialog blocks to truncated snapshots
- **Positional `.nth(occurrenceIndex)`** — avoids strict-mode violations on
  duplicate role+name elements
- **Snapshot fingerprint DOM-change detection** — warns agent when SPA
  navigation invalidates cached @e refs
- **Bot detection downgrade heuristic** — marks navigate as failed when
  `botDetected && elementCount < 5`
- **Verify-click occlusion fallback** — 1.5s short click attempt to
  eliminate false positives (Reddit close button with nested SVG/img)

**The problem**: each fix was developed and tested in isolation, often
against a single site's specific behavior. We have **no integrated
understanding** of how these fixes interact in complex real-world
scenarios. "Sometimes succeed, sometimes fail" on Reddit dialogs suggests
a race condition, a timing sensitivity, or an interaction between two
overlapping fixes.

This document defines a methodology to:

1. **Profile** real end-to-end behavior with instrumentation
2. **Isolate** root causes by testing hypotheses independently
3. **Fix** the underlying design issue, not the symptom
4. **Validate** that the fix works across both backends and doesn't
   regress existing tests

---

## 2. Diagnostic Categories

When a dialog close fails on Reddit (or any complex SPA), the failure
can originate in one of several layers:

### Layer 1: Snapshot / Accessibility Tree

| Symptom | Possible Root Causes |
|---------|----------------------|
| Dialog not in snapshot at all | Async timing (dialog rendered after snapshot taken); dialog rendered as `<div>` without `role="dialog"`; dialog outside interactive DOM (shadow DOM, iframe) |
| Dialog present but @e ref wrong | Dialog elements re-rendered between snapshot and click (SPA); element tree changed order (occurrenceIndex mismatched) |
| Dialog truncated by cap | `maxElements` with non-dialog elements consuming budget; dialog not detected as `"dialog"` role (custom ARIA pattern) |

**Key question**: is the dialog visible in `page.ariaSnapshot()` output
at the moment the agent tries to click it?

### Layer 2: Element Cache / Locator Resolution

| Symptom | Possible Root Causes |
|---------|----------------------|
| "Element not found in accessibility tree" | Session changed; `plugin.click` called with ref from a different snapshot; cache cleared by intervening operation |
| Strict mode violation | Two elements with same role+name at the time of click (occurrenceIndex fix should handle this — but only if the DOM structure matches the snapshot) |

**Key question**: does the @e ref resolve to the correct element at
click time?

### Layer 3: Occlusion Detection

| Symptom | Possible Root Causes |
|---------|----------------------|
| "Element obscured" on valid dialog button | `elementFromPoint` returns child element (false positive — the verify-click fallback should handle this, but maybe the 1.5s timeout is too short for Reddit's slow rendering) |
| Occlusion not detected on genuinely hidden element | Dialog is an ancestor and `el.contains(topEl)` incorrectly returns true; element scrolled out of viewport during check |

**Key question**: is the occlusion check accurate for this specific
dialog pattern?

### Layer 4: Timing / Race Conditions

| Symptom | Possible Root Causes |
|---------|----------------------|
| Click works intermittently | 300ms `waitForTimeout` after navigation not enough for SPA rendering; dialog appears via CSS animation with >300ms delay; Cloudflare/bot check delays `page.goto` completion |
| Snapshot shows different elements each time | SPAs (Reddit, Twitter) render content asynchronously; `waitForFunction` stabilization only checks element count, not dialog presence |

**Key question**: is there a timing dependency between when we check
and when Reddit renders the dialog?

---

## 3. Instrumentation Layer

Before experimenting, add lightweight instrumentation to trace what
actually happens during a dialog interaction. This should be **opt-in**
(environment variable), not always-on.

### 3.1 Logging Schema

Add a structured log line for each of these events:

```
[browser] navigate: url=..., plugin=..., success=..., botDetected=..., elementCount=..., time=...
[browser] snapshot: taskId=..., success=..., elementCount=..., dialogBlocks=..., fingerprint=..., time=...
[browser] click: taskId=..., ref=@eN, role=..., name=..., occlusionCheck=...|skipped, result=..., time=...
[browser] occlusion: ref=@eN, isObscured=true|false, verifyClick=success|fail|skipped, reason=elementFromPoint|viewport|zeroSize
```

Implementation pattern:

```typescript
// In backends/chromium/index.ts
const DEBUG = process.env.BROWSER_DEBUG === "1";

function log(event: string, data: Record<string, unknown>): void {
  if (DEBUG) console.error(`[browser] ${event}: ${JSON.stringify(data)}`);
}
```

```python
# In backends/chromium-py/bridge.py
import os, json, sys

DEBUG = os.environ.get("BROWSER_DEBUG") == "1"

def _log(event: str, **data: Any) -> None:
    if DEBUG:
        print(f"[browser] {event}: {json.dumps(data)}", file=sys.stderr)
```

**Caution**: Add to both TypeScript and Python backends independently.
Do NOT add a new JSON-RPC method for logging — the Python adapter writes
to stderr, which is already captured by the TypeScript `_stderrAccumulated`
buffer. The TypeScript backend writes to `console.error`.

### 3.2 Trace Capture

For diagnosing Reddit-specific issues, add optional Playwright trace
capture:

```typescript
// In ChromiumPlugin, before navigate
if (process.env.BROWSER_TRACE_DIR) {
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
}

// In cleanup
if (process.env.BROWSER_TRACE_DIR) {
  await context.tracing.stop({
    path: join(process.env.BROWSER_TRACE_DIR, `trace-${taskId}-${Date.now()}.zip`),
  });
}
```

Traces can be viewed at `https://trace.playwright.dev/` to inspect
exactly what the page looked like at each interaction.

### 3.3 Interaction Waterfall

Add a "waterfall" timer for complex operations so we can identify
which phase is slow:

```typescript
const phases: Record<string, number> = {};

// In click():
phases["locate"] = performance.now();
locator = buildLocator(...);

phases["occlusion"] = performance.now();
// ... occlusion check ...

phases["click"] = performance.now();
await locator.click();

phases["wait"] = performance.now();
await page.waitForTimeout(300);

phases["snapshot"] = performance.now();
// ... take snapshot ...

const labels = Object.keys(phases);
for (let i = 0; i < labels.length - 1; i++) {
  const a = labels[i]!;
  const b = labels[i + 1]!;
  log("timing", { ref, a, b, ms: (phases[b]! - phases[a]!).toFixed(1) });
}
```

---

## 4. Controlled Experiment Framework

Build a lightweight framework for running repeatable browser experiments
against both backends. The goal is to eliminate site-specific variability
(Reddit's CDN, A/B testing, ad blockers) so we can test hypotheses in
isolation.

### 4.1 Test Fixture Categories

Create a set of HTML fixtures in the test server that model each
dialog pattern observed in the wild:

| Fixture | What It Tests | Reference Site |
|---------|---------------|----------------|
| `<div role="dialog">` with simple buttons | Basic dialog prioritisation, occlusion | Most sites |
| `<div role="alertdialog">` with nested `<button>` containing `<svg>` | False-positive occlusion with icon buttons | Reddit close button |
| `<aside role="complementary">` styled as overlay | Non-dialog overlay not in accessibility tree | Some cookie banners |
| Two stacked `<div role="dialog">` | Multi-dialog scenario (close one, reveal another) | Reddit consent + welcome |
| Dialog with `animation: fadeIn 500ms` | Timing sensitivity | Various |
| Dialog rendered via dynamic `<script>` after 200-1000ms | Async rendering race | Reddit, SPAs |
| `<div role="dialog">` with 30+ interactive children | Dialog prioritisation near the 500-element cap | Reddit feed with modal |
| Dialog inside a shadow DOM | Shadow DOM interaction | Emerging pattern |
| `<iframe>` with dialog content | Cross-origin dialog | Embedded widgets |
| Dialog with `aria-hidden="true"` on background | Contrast with accessibility tree | Properly built apps |

### 4.2 Side-by-Side Test Runner

A script that runs the same sequence against both backends and compares
results:

```bash
# Concept — not implemented yet
node scripts/compare-backends.mjs \
  --url "https://old.reddit.com/r/test" \
  --actions '["navigate","snapshot","click @e42","snapshot"]' \
  --backends "chromium,chromium-py" \
  --repeat 10
```

Output: a table comparing success rates, timing, element counts, and
dialog presence for each backend × action combination.

Implementation location: `scripts/dialog-gate.mjs` (new file, not a test).

### 4.3 Reddit-Specific Fixture

The most important fixture: a static HTML page that replicates the
critical dialog patterns from Reddit's current front-end. Reddit changes
its DOM frequently, so a live site test will never be deterministic.
Instead, capture the relevant DOM structure from Reddit and create a
static fixture:

```html
<!DOCTYPE html>
<html>
<head><title>Reddit-like Dialog Test</title></head>
<body>
  <!-- Simulate a reddit feed with 100+ items -->
  <div id="feed">
    <!-- 100 post items, each with link, author, score etc -->
    ...
  </div>

  <!-- Simulate the data-consent dialog overlay -->
  <div class="ConsentOverlay" style="position:fixed; top:0; left:0; width:100%; height:100%; z-index:1000; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center;">
    <div class="ConsentDialog" role="dialog" aria-label="Data Protection Consent" style="background:white; padding:24px; border-radius:16px;">
      <h2>Data Protection Consent</h2>
      <p>We use cookies etc etc...</p>
      <div class="actions">
        <button onclick="this.closest('.ConsentOverlay').style.display='none'" style="padding:8px 16px">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span>Reject All</span>
        </button>
        <button onclick="this.closest('.ConsentOverlay').style.display='none'" style="padding:8px 16px">
          <span>Accept All</span>
        </button>
      </div>
    </div>
  </div>
</body>
</html>
```

This fixture should be added to `__tests__/helpers/test-server.ts` and
exercised by the contract test harness.

---

## 5. Root Cause Analysis Protocol

When investigating an intermittent failure, follow this protocol step
by step. Each step either identifies the root cause or rules out a
category.

### Step 1: Reproduce with Instrumentation

```
BROWSER_DEBUG=1 npx vitest run ...
```

Check the structured logs for the failing interaction. Key questions:

- Was the dialog present in the snapshot? (snapshot `dialogBlocks=` count)
- Did the occlusion check fire? (occlusion `isObscured=true|false`)
- Did the verify-click succeed or fail?
- How long did each phase take? (timing entries)

### Step 2: Capture a Trace

```
BROWSER_TRACE_DIR=./traces npx vitest run ...
```

Open the trace in Playwright's trace viewer. Check:

- What did `ariaSnapshot()` return at the moment of the click?
- Was the dialog actually visible on screen?
- Did the click land on the right element?

### Step 3: Isolate the Variability

Run the same interaction 10+ times in a loop to measure consistency:

```typescript
// In a test file
it("consistently closes dialog × 10", async () => {
  for (let i = 0; i < 10; i++) {
    await plugin.navigate(`${server.url}/reddit-dialog`, "t1", 15_000);
    const snap = await plugin.snapshot("t1");
    const ref = findDialogCloseRef(snap.snapshot);
    const result = await plugin.click("t1", ref);
    expect(result.success).toBe(true);
    // Verify dialog is gone
    const after = await plugin.snapshot("t1");
    expect(after.snapshot).not.toMatch(/dialog/);
    await plugin.cleanup("t1");
  }
});
```

If the test passes 10/10 with the fixture but fails on real Reddit,
the issue is site-specific (CDN, A/B testing, dynamic content).
If it also fails on the fixture, the issue is in our code.

### Step 4: A/B Test the Fix

For each suspected root cause, create a minimal modification and test
it against the failing scenario:

| Hypothesis | Test | Measure |
|------------|------|---------|
| Timing: 300ms wait is too short | Increase to 1000ms | Success rate difference |
| Timing: `waitUntil: "load"` is too early | Add `waitUntil: "networkidle"` | Dialog presence in snapshot |
| Occlusion: false positive | Disable occlusion check | Success rate difference |
| Snapshot: dialog not in ARIA tree | Use `page.evaluate` to check DOM directly | Whether dialog has `role="dialog"` attribute |
| Cache: stale occurrenceIndex | Force `parseSnapshot` before click | Whether indices changed |
| Dialog: wrong role attribute | Log the actual role of the overlay element | What role (if any) Reddit assigns |

### Step 5: Verify Fix Doesn't Break Anything

Before applying a fix:

- Run full test suite: `npx vitest run` (all TypeScript + Python tests)
- Run contract tests for both backends
- Run A/B comparison: old code vs new code on the same fixture × 20 iterations
- Check the fix is applied to BOTH backends (TypeScript Chromium AND Python Chromium-Py)

---

## 6. Common Failure Patterns & Hypotheses

Based on the existing code structure and known Reddit behavior, here
are the most likely root causes for "sometimes succeed, sometimes fail"
on dialog closing:

### H1: Dialog Not in Accessibility Tree (Most Likely)

Reddit may not mark its overlays with `role="dialog"` or
`role="alertdialog"`. If the overlay is a plain `<div>` with CSS
positioning and `aria-label`, it won't appear in Playwright's
`ariaSnapshot()` output at all.

**Check**: Instrument `ariaSnapshot()` output and check for
`dialog`/`alertdialog` lines when the failure occurs.

**Fix options**:
- A: Wait and retry the snapshot (dialog may render asynchronously)
- B: Use `page.evaluate()` to detect overlays by visual properties
  (fixed position, full-screen z-index) and fall back to DOM-based
  interaction
- C: Accept that some dialogs are invisible to the accessibility tree
  and guide the agent to use `browser-console` with JS to dismiss them

### H2: Timing Race Between Snapshot and Click

The flow is:
1. Agent calls `browser-navigate` → our code takes a snapshot after
   `waitForFunction` stabilization
2. Agent inspects the snapshot, picks an @e ref
3. Agent calls `browser-click @eN` → our code resolves from cache

If Reddit's dialog renders **between** steps 1 and 2, the agent has
a snapshot without the dialog, and the click on some other element
either fails or does nothing.

**Check**: Compare `page.ariaSnapshot()` at navigate time vs at click
time.

**Fix options**:
- A: Before every click, do a quick "dialog check" — call
  `page.evaluate()` to detect overlays and, if present, re-snapshot
  automatically
- B: Reduce the window between snapshot and click by taking a second
  snapshot in the click handler (we already auto-snapshot, but the
  agent's decision is based on the old snapshot)
- C: Add a "wait for dialog to appear" step after navigation
  (wait for `[role="dialog"]` to be visible)

### H3: Verify-Click Timeout Too Short

The occlusion check in both backends uses 1.5s for the verify-click
fallback. Reddit's SPA is slow — if the button's click handler takes
>1.5s to respond (due to Reddit's bundle loading or rendering), the
verify-click will timeout, and the occlusion error will be returned
even though the element is not actually obscured.

**Check**: With `BROWSER_DEBUG=1`, does the `occlusion` log show
`verifyClick=success` or `verifyClick=fail`?

**Fix options**:
- A: Increase verify-click timeout to 3s for known-slow SPAs
- B: Skip the verify-click fallback for dialog elements (they're the
  foreground by definition, so occlusion shouldn't apply)
- C: Make the verify-click timeout configurable per-session

### H4: Element Cache Stale After Auto-Snapshot

Every interaction tool returns an auto-snapshot. If the dialog changes
between the auto-snapshot and the agent's next click, the @e refs from
the auto-snapshot may point to different elements.

The `snapshotFingerprint` DOM-change detection warns the agent about
this, but the agent may ignore the warning or not see it (if the
warning text is compacted).

**Check**: Is the fingerprint warning present in the auto-snapshot when
the failure occurs?

**Fix options**:
- A: When the fingerprint changes, re-parse the snapshot and update
  the element cache automatically before the agent's next click
- B: Make the fingerprint warning more prominent (always-uncompacted)
- C: Always cache the latest snapshot elements so @e refs never go stale

### H5: Multiple Dialogs Stacked

Reddit sometimes shows a consent dialog, and after accepting it, shows
a "welcome" or "get the app" dialog. If the agent closes dialog A but
the auto-snapshot shows dialog B already, the agent may try to interact
with dialog A's refs that no longer exist.

**Check**: Does the auto-snapshot after clicking "Reject All" show a
new dialog (different name/label)?

**Fix options**:
- A: The fingerprint change should catch this — if the snapshot changes
  significantly, the warning should trigger
- B: After closing a dialog, wait for the change to propagate before
  returning the auto-snapshot (poll for DOM stability)
- C: Auto-retry interaction if the ref no longer resolves (fall back to
  fresh snapshot)

---

## 7. Proposed Experiments (Ordered by Impact)

### Experiment 1: Dialog Detection Reliability

**Goal**: Determine whether Reddit's dialogs appear in `ariaSnapshot()`.

**Method**:
1. Add `page.evaluate()` to both backends that checks for overlay
   elements by visual properties (fixed position, full viewport size,
   high z-index) independently of `ariaSnapshot()`.
2. Log whether the widget was found and what role it has.

**Success criteria**: We know for certain whether the issue is "dialog
not in ARIA tree" or something else.

**Duration**: 1 session with live Reddit.

### Experiment 2: Verify-Click Sensitivity

**Goal**: Determine if the 1.5s verify-click is causing false positives.

**Method**:
1. Add configurable `verifyClickTimeoutMs` parameter to both backends
   (default: 1500).
2. Run the Reddit fixture × 20 with `verifyClickTimeoutMs = 3000`.
3. Compare success rate with the default 1500ms.

**Success criteria**: If 3s improves success rate, the issue is timing.
If not, the issue is elsewhere.

**Duration**: 2 sessions (one with default, one with increased).

### Experiment 3: Snapshot Timing Window

**Goal**: Measure the time between snapshot and click on real Reddit.

**Method**:
1. Add logging of snapshot age (time since last snapshot) when click
   is called.
2. Run the Reddit flow 10 times.
3. Check if failures correlate with snapshot age > N seconds.

**Success criteria**: If all failures have stale snapshots (>5s since
last snapshot), the issue is timing-window related.

**Duration**: 1 session with live Reddit.

### Experiment 4: Auto-Fresh Element Cache

**Goal**: Eliminate stale @e refs.

**Method**:
1. Before every click, call `page.ariaSnapshot()` and re-parse it.
2. If the element cache contents changed (different ref-to-node mapping),
   update the cache transparently and retry the ref lookup.
3. Run the Reddit fixture × 20 with and without this change.

**Success criteria**: If auto-refresh improves success rate, stale
caches were the cause. Determine cost: how much extra latency per click?

**Duration**: 2 sessions (one with, one without).

### Experiment 5: Side-by-Side Backend Comparison

**Goal**: Confirm that both backends behave identically.

**Method**:
1. Run the same dialog-closing test sequence against both ChromiumPlugin
   (TypeScript) and ChromiumPyBridge (Python).
2. Compare: success rate, timing, dialog block count, element count,
   footprint hash after each interaction.

**Success criteria**: If both backends fail the same way, the issue
is architectural (not backend-specific). If only one fails, the issue
is in that backend's implementation.

**Duration**: 2 parallel sessions.

---

## 8. Fix Application Principles

When a root cause is identified and a fix is designed, apply these
principles to avoid the "chain of hacky patches" problem:

### 8.1 One Fix per Root Cause

Each fix should target exactly one root cause. If you fix two things
at once, you won't know which one worked (or which one regressed).

### 8.2 Add a Dedicated Test

Every fix must come with a test that:
- **Fails without the fix** (reproduces the bug)
- **Passes with the fix** (confirms the resolution)
- **Does NOT pass for unrelated reasons** (no coincidental passing)

Ideally, the test uses a static fixture (not a live site) so it's
deterministic.

### 8.3 Apply to Both Backends

Every behavioral fix in `core/` or `backends/chromium/` must have an
equivalent in `backends/chromium-py/bridge.py` and
`backends/python-base/pi_browser_bridge/` unless the fix is
engine-specific.

Add a cross-reference in the PR description:

```
TypeScript: core/shared/accessibility-tree.ts — two-pass dialog prioritisation
Python:     backends/python-base/pi_browser_bridge/accessibility.py — same logic
```

### 8.4 Document the Interaction Surface

If a fix changes the behavior visible to the agent (new error messages,
changed return values, new warnings), update:

- `AGENTS.md` — agent-facing documentation
- Tool `promptGuidelines` in `index.ts` — in-context guidance
- The relevant test's `describe` block name — so future devs know
  what behavior is expected

### 8.5 Prefer Architecture over Configuration

If you find yourself adding a `config.*` parameter (timeout, threshold,
toggle), ask: **"Is there a way to derive this value from the
situation rather than requiring configuration?"**

Good: `waitForTimeout(300)` → `waitForFunction("dialog rendered")`
Better: auto-detect dialog presence by polling `ariaSnapshot()` diff

Configuration hides understanding. Deduction reveals it.

---

## 9. End-to-End Validation Checklist

After any dialog-related fix, validate against this checklist:

### 9.1 Unit Tests

- [ ] **Structural tests pass** (shape of result objects, error fields)
- [ ] **Occlusion tests pass** (modal overlay blocks background, allows
  overlay elements, icon-button false positive)
- [ ] **Duplicate element tests pass** (strict-mode violation fix)
- [ ] **Dialog prioritisation tests pass** (dialog elements always get
  @e refs under the cap)
- [ ] **Fingerprint DOM-change tests pass** (snapshot after content
  change warns agent)
- [ ] **Bot detection downgrade tests pass** (botDetected + low
  elementCount → success: false)

### 9.2 Contract Tests

- [ ] **`runContractTests("mock", ...)` — all pass** (structural)
- [ ] **`runContractTests("chromium", ..., { realBrowser: true })` — all
  pass** (behavioral)
- [ ] **`runContractTests("chromium-py", ..., { realBrowser: true })` —
  all pass** (Python backend behavioral)

### 9.3 Backend Comparison

- [ ] TypeScript Chromium and Python Chromium-Py give the same result
  for:
  - Simple dialog fixture
  - Icon-button fixture
  - Stacked dialogs fixture
  - Async-rendered dialog fixture

### 9.4 Live Site (Manual)

- [ ] Reddit: close consent dialog successfully
- [ ] Reddit: close any post-consent welcome dialog
- [ ] Reddit: click a post link after dialog is dismissed
- [ ] Guardian / similar: close cookie consent dialog
- [ ] Google: interact with cookie preferences (reject non-essential)

### 9.5 Regression

- [ ] **No test file count reduction**: all 13 `.test.ts` files exist
- [ ] **All 408 TypeScript tests pass** (or current baseline + new tests)
- [ ] **All 213 Python tests pass** (or current baseline + new tests)
- [ ] **`tsc --noEmit` clean**
- [ ] **`grep -rn "TODO\|FIXME\|HACK\|XXX" | grep -v node_modules`** —
  zero matches in our codebase
- [ ] **`grep -rn "BackendLevel"`** — zero matches (fully migrated to
  `pluginName: string`)

---

## 10. Implementation Plan

### Phase 1: Instrumentation (30 min)

1. Add `BROWSER_DEBUG` environment variable logging to TypeScript
   ChromiumPlugin (`backends/chromium/index.ts`)
2. Add `BROWSER_DEBUG` logging to Python ChromiumPyBridge
   (`backends/chromium-py/bridge.py`)
3. Add Playwright trace capture (opt-in via `BROWSER_TRACE_DIR`)

### Phase 2: Reddit Fixture (30 min)

1. Capture Reddit's current consent dialog DOM structure
2. Create `__tests__/helpers/reddit-fixture.ts` with static HTML
3. Add to `test-server.ts` handler
4. Add behavioral contract test that exercises the fixture

### Phase 3: Side-by-Side Runner (1 hour)

1. Create `scripts/dialog-gate.mjs` — script that runs action sequences
   against both backends and reports a comparison table
2. Run on Reddit fixture × 20 each for baseline success rate

### Phase 4: Run the Experiments (1 hour per experiment)

1. Execute Experiments 1-5 in order
2. Document findings per experiment
3. If root cause identified, design fix per §8 principles
4. If no root cause identified, expand diagnostic coverage

### Phase 5: Fix & Validate (2 hours)

1. Implement fix
2. Add dedicated test
3. Apply to both backends
4. Run checklist (§9)
5. Remove `BROWSER_DEBUG`/`BROWSER_TRACE_DIR` instrumentation
   (or gate behind `NODE_ENV !== "production"`)

---

## 11. When to Stop

Stop fine-tuning when:

1. **All checklist items in §9 pass.** Both backends produce identical,
   deterministic results on all fixtures.
2. **No unexplained failures in 20 consecutive runs** on the Reddit
   fixture.
3. **The fix is architectural, not configurational.** No new timeouts,
   thresholds, or toggles were added.
4. **The fix doesn't reduce robustness elsewhere.** Existing tests still
   pass at the same or higher count.

If after Phase 4 no clear root cause is found, document the remaining
ambiguity and move to Phase C. Some failures may be inherent to
Playwright's `ariaSnapshot()` or Reddit's DOM structure — not fixable
in our code without introducing fragility.
