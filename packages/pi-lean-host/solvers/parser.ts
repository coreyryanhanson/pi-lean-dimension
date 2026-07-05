/**
 * Accessibility-snapshot parsing helpers for MiniWoB++ trivial solvers.
 *
 * Provides `@e`-ref extraction, role-keyword filtering (with the
 * tightened regex that avoids matching roles inside quoted accessible
 * names), and goal-utterance text extraction.
 *
 * Moved from `pi-lean-portal/__tests__/helpers/miniwob-suite.ts` as part
 * of the BrowserGym migration (Batch C, §1.5). The `withRole` regex is
 * tightened per the reviewer's finding: it now matches only in the
 * prefix before the first `"`, so a button named `"click the button"`
 * doesn't produce a false match for the `button` role keyword.
 *
 * @module
 */

// ─── Types ────────────────────────────────────────────────────────

/**
 * A minimal view of an `@e`-ref snapshot line: ref, accessible name,
 * and the raw line (kept for role-keyword substring checks).
 */
export interface SnapEl {
	ref: string;
	name: string;
	line: string;
}

// ─── Parsing ──────────────────────────────────────────────────────

/**
 * Parse an accessibility snapshot into {@link SnapEl}s, one per
 * `@e<digits>` line. Role is NOT parsed out as a field; use
 * {@link withRole} to filter by role keyword.
 *
 * The snapshot line format (from `core/shared/accessibility-tree.ts`)
 * is `{indent}@e{n} {icon} {role} "{name}" [props]`, where the icon
 * carries a trailing space (e.g. `🔘 `). We extract the ref via
 * `/@(e\d+)/` and the name via `/"([^"]*)"/`; role is left to
 * {@link withRole} for tolerant matching.
 */
export function parseRefs(snapshot: string): SnapEl[] {
	const out: SnapEl[] = [];
	for (const line of snapshot.split("\n")) {
		const refMatch = line.match(/@(e\d+)/);
		if (!refMatch?.[1]) continue;
		const nameMatch = line.match(/"([^"]*)"/);
		out.push({
			ref: `@${refMatch[1]}`,
			name: nameMatch?.[1] ?? "",
			line,
		});
	}
	return out;
}

/**
 * Allowlisted role keywords for `withRole`. Hardcoded to prevent
 * arbitrary regex injection (ReDoS) from caller input.
 */
const ALLOWED_ROLES = new Set([
	"button",
	"textbox",
	"searchbox",
	"link",
	"checkbox",
	"radio",
	"menuitem",
	"combobox",
	"listbox",
	"option",
	"tab",
	"treeitem",
	"switch",
	"slider",
	"spinbutton",
	"progressbar",
	"dialog",
	"alertdialog",
]);

/**
 * Filter elements whose snapshot line contains the role keyword in the
 * prefix before the first quoted accessible name.
 *
 * The rendered line embeds the role literally before the first `"`
 * (e.g. `@e2 🔘 button "Cancel"`). By splitting on `"` and only
 * matching in the prefix, we avoid false positives when the role
 * keyword appears inside an accessible name (e.g. a button labelled
 * `"click the button"`).
 *
 * Throws if `roleKeyword` is not in the allowlist — this is a
 * safety measure against arbitrary regex injection. All known MiniWoB
 * role keywords are covered; extend {@link ALLOWED_ROLES} when adding
 * a solver that needs a new one.
 */
export function withRole(els: SnapEl[], roleKeyword: string): SnapEl[] {
	if (!ALLOWED_ROLES.has(roleKeyword)) {
		throw new RangeError(
			`withRole: "${roleKeyword}" is not in the allowlist. ` +
				`Add it to ALLOWED_ROLES in parser.ts before using it. ` +
				`Known roles: ${[...ALLOWED_ROLES].sort().join(", ")}`,
		);
	}
	const re = new RegExp(`\\b${roleKeyword}\\b`);
	return els.filter((e) => {
		const prefix = e.line.split('"')[0] ?? e.line;
		return re.test(prefix);
	});
}

/** Find the first element whose line contains any of the keywords. */
export function firstWith(
	els: SnapEl[],
	...roleKeywords: string[]
): SnapEl | undefined {
	for (const kw of roleKeywords) {
		const found = withRole(els, kw);
		if (found.length > 0) return found[0];
	}
	return undefined;
}

/**
 * Extract double-quoted strings from the goal utterance. MiniWoB
 * utterances typically quote the target text (button name, link text,
 * the text to type, the username/password), e.g.
 * `Click on the "Cancel" button` or `Enter "hello world" into the
 * textfield`. Returns `[]` when the utterance is unquoted — callers
 * fall back to a generic action in that case.
 */
export function goalQuotedTexts(goal: string): string[] {
	const out: string[] = [];
	const re = /"([^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(goal)) !== null) {
		if (m[1]) out.push(m[1]);
	}
	return out;
}
