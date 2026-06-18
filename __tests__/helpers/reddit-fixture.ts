/**
 * Reddit-style dialog fixture — shared helper for consent dialog tests.
 *
 * Provides four HTML variants of a Reddit-like feed page with consent
 * dialogs, plus helper functions for extracting @e references and
 * counting dialog elements from accessibility snapshots.
 *
 * Exports
 * -------
 *   REDDIT_DIALOG_HTML   — feed + consent dialog overlay (baseline)
 *   REDDIT_STACKED_HTML  — feed → consent dialog → "Welcome Back" dialog
 *   REDDIT_ASYNC_HTML    — feed loads first, dialog appears via setTimeout
 *   REDDIT_FEED_ONLY_HTML— feed without dialog (baseline)
 *   findRef(snapshot, text) → {ref, role?, name?, line} | null
 *   dialogCount(snapshot) → number
 */

// ─── Helpers ──────────────────────────────────────────────────────

/** Generate N feed article items with deterministic content. */
function generateFeedPosts(count: number): string {
	return Array.from(
		{ length: count },
		(_, i) =>
			`  <article>
    <h2><a href="/post-${i + 1}">Post Title ${i + 1}</a></h2>
    <span>Author_${i + 1}</span>
    <span>Score: ${100 - i}</span>
    <a href="/comments-${i + 1}">${(i % 49) + 1} comments</a>
  </article>`,
	).join("\n");
}

// ─── Dialog HTML fragments ────────────────────────────────────────

const CONSENT_DIALOG_STYLE = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.6); z-index: 1000;
    display: flex; align-items: center; justify-content: center;
`.trim();

const CONSENT_DIALOG_CSS = `
    background: white; padding: 2rem; border-radius: 12px;
    max-width: 440px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.3);
`.trim();

/**
 * The consent dialog overlay with "Reject All" (nested SVG) and "Accept All".
 * Reddit's actual pattern uses an SVG close icon inside the reject button
 * — this triggers the occlusion false-positive that we want to test.
 */
function consentOverlayHtml(dismissFn: string, acceptFn: string): string {
	return `<div role="dialog" aria-label="Data Protection Consent" id="consent-overlay" style="${CONSENT_DIALOG_STYLE}">
  <div id="consent-dialog" style="${CONSENT_DIALOG_CSS}">
    <h2>Data Protection Consent</h2>
    <p>We use cookies and similar technologies to provide our services.</p>
    <div style="display:flex; gap:8px; justify-content:center; margin-top:16px;">
      <button onclick="${dismissFn}()"
        style="padding:8px 16px; cursor:pointer; border:1px solid #ccc; border-radius:4px;">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
             style="vertical-align:middle">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span style="vertical-align:middle">Reject All</span>
      </button>
      <button onclick="${acceptFn}()"
        style="padding:8px 16px; cursor:pointer; background:#0079d3; color:white; border:none; border-radius:4px;">
        Accept All
      </button>
    </div>
  </div>
</div>`;
}

const FEED_SECTION = `<div role="feed" aria-label="Reddit feed">
${generateFeedPosts(100)}
</div>`;

const STACKED_JS = `
function showWelcomeDialog() {
  var w = document.createElement('div');
  w.id = 'welcome-overlay';
  w.setAttribute('role', 'dialog');
  w.setAttribute('aria-label', 'Welcome Back');
  w.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:1000; display:flex; align-items:center; justify-content:center;';
  w.innerHTML = '<div style="background:white; padding:2rem; border-radius:12px; max-width:440px; text-align:center; box-shadow:0 4px 24px rgba(0,0,0,0.3);"><h2>Welcome Back</h2><p>Thanks for your consent preferences.</p><button onclick="dismissWelcome()" style="padding:8px 16px; cursor:pointer; border:1px solid #ccc; border-radius:4px;">Dismiss</button></div>';
  document.body.appendChild(w);
}
function dismissConsent() {
  document.getElementById('consent-overlay').style.display = 'none';
  showWelcomeDialog();
  window._dialogDismissed = true;
}
function acceptConsent() {
  document.getElementById('consent-overlay').style.display = 'none';
  showWelcomeDialog();
  window._dialogAccepted = true;
}
function dismissWelcome() {
  var el = document.getElementById('welcome-overlay');
  if (el) el.style.display = 'none';
  window._welcomeDismissed = true;
}
`;
// ─── Page variants ────────────────────────────────────────────────

/**
 * Baseline: 100 feed posts + a consent dialog overlay.
 *
 * The dialog covers the entire viewport. The "Reject All" button
 * contains a nested `<svg>` to test occlusion false-positive detection.
 */
export const REDDIT_DIALOG_HTML = `<!DOCTYPE html>
<html><head><title>Reddit — Consent Dialog</title></head>
<body>
<script>
  function dismissConsent() {
    document.getElementById('consent-overlay').style.display = 'none';
    window._dialogDismissed = true;
  }
  function acceptConsent() {
    document.getElementById('consent-overlay').style.display = 'none';
    window._dialogAccepted = true;
  }
</script>
${FEED_SECTION}
${consentOverlayHtml("dismissConsent", "acceptConsent")}
<footer><p>Reddit feed footer</p></footer>
</body></html>`;

/**
 * Stacked variant: consent dialog → upon dismiss reveals "Welcome Back".
 *
 * Closing dialog A (consent) makes dialog B (welcome) appear.
 * Tests that the router correctly sequences through stacked dialogs.
 */
export const REDDIT_STACKED_HTML = `<!DOCTYPE html>
<html><head><title>Reddit — Stacked Dialogs</title></head>
<body>
<script>
${STACKED_JS}
</script>
${FEED_SECTION}
${consentOverlayHtml("dismissConsent", "acceptConsent")}
<footer><p>Reddit feed footer</p></footer>
</body></html>`;

/**
 * Async variant: feed loads immediately, dialog appears after 500ms.
 *
 * Tests timing-dependent scenarios where the dialog arrives after the
 * initial snapshot. The agent must handle the delayed dialog appearance.
 */
export const REDDIT_ASYNC_HTML = `<!DOCTYPE html>
<html><head><title>Reddit — Async Dialog</title></head>
<body>
<script>
  function dismissConsent() {
    document.getElementById('consent-overlay').style.display = 'none';
    window._dialogDismissed = true;
  }
  function acceptConsent() {
    document.getElementById('consent-overlay').style.display = 'none';
    window._dialogAccepted = true;
  }
  setTimeout(function() {
    var el = document.getElementById('consent-overlay');
    if (el) el.style.display = 'flex';
  }, 500);
</script>
${FEED_SECTION}
<div role="dialog" aria-label="Data Protection Consent" id="consent-overlay" style="display:none; ${CONSENT_DIALOG_STYLE}">
  <div id="consent-dialog" style="${CONSENT_DIALOG_CSS}">
    <h2>Data Protection Consent</h2>
    <p>This dialog appeared after the page loaded.</p>
    <div style="display:flex; gap:8px; justify-content:center; margin-top:16px;">
      <button onclick="dismissConsent()"
        style="padding:8px 16px; cursor:pointer; border:1px solid #ccc; border-radius:4px;">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
             style="vertical-align:middle">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span style="vertical-align:middle">Reject All</span>
      </button>
      <button onclick="acceptConsent()"
        style="padding:8px 16px; cursor:pointer; background:#0079d3; color:white; border:none; border-radius:4px;">
        Accept All
      </button>
    </div>
  </div>
</div>
<footer><p>Reddit feed footer</p></footer>
</body></html>`;

/**
 * Feed-only variant (no dialog at all) — baseline for occlusion testing.
 * Ensures feed links are clickable when no dialog obscures them.
 */
export const REDDIT_FEED_ONLY_HTML = `<!DOCTYPE html>
<html><head><title>Reddit — Feed Only</title></head>
<body>
${FEED_SECTION}
<footer><p>Reddit feed footer — no dialog</p></footer>
</body></html>`;

// ─── Helper functions ─────────────────────────────────────────────

export interface RefInfo {
	/** The @e reference string, e.g. "@e5" */
	ref: string;
	/** Accessibility role of the element, e.g. "button" */
	role?: string;
	/** Accessible name of the element, e.g. "Reject All" */
	name?: string;
	/** The full snapshot line containing the match */
	line: string;
}

/**
 * Find the first @e reference in a snapshot whose line contains `text`.
 *
 * Useful for locating interactive elements by their accessible name
 * (or partial text) in accessibility tree output.
 *
 * @example
 *   const info = findRef(snap.snapshot, "Reject All");
 *   if (info) await plugin.click(taskId, info.ref);
 *
 * @param snapshot  Accessibility tree snapshot string (from NavigateResult or SnapshotResult)
 * @param text      Substring to search for in snapshot lines
 * @returns RefInfo if found, null otherwise
 */
export function findRef(snapshot: string, text: string): RefInfo | null {
	const lines = snapshot.split("\n");
	for (const line of lines) {
		if (line.includes(text)) {
			const refMatch = line.match(/@(e\d+)/);
			if (refMatch) {
				const roleMatch = line.match(/\[(\w+)\]/);
				const nameMatch = line.match(/"([^"]+)"/);
				const info: Partial<RefInfo> & Pick<RefInfo, "ref" | "line"> = {
					ref: `@${refMatch[1]!}`,
					line,
				};
				if (roleMatch?.[1]) info.role = roleMatch[1];
				if (nameMatch?.[1]) info.name = nameMatch[1];
				return info as RefInfo;
			}
		}
	}
	return null;
}

/**
 * Count how many dialog elements appear in a snapshot.
 *
 * Matches accessibility tree dialog role markers (`💬 dialog "..."`).
 *
 * @param snapshot  Accessibility tree snapshot string
 * @returns Number of distinct dialog elements found
 */
export function dialogCount(snapshot: string): number {
	return (snapshot.match(/dialog\s+"/g) || []).length;
}
