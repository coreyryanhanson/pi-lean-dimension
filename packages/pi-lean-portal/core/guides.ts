/**
 * Web Navigation Guides
 *
 * Stateless, applicable-only guide footer system. All guides are surfaced
 * the same way — no inject/hint distinction, no per-task suppression state.
 *
 * Types, data, file loader, resolution, and footer formatting are all
 * in this single file.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { PORTAL_DATA_DIR } from "./shared/paths.js";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type GuideCategory = "site" | "pattern";
export type GuideSource = "builtin" | "user";

export interface Guide {
	/** Markdown guidance text (≤800 chars recommended). */
	content: string;
	/** ISO date of last update. */
	updated: string;
	category: GuideCategory;
	source: GuideSource;
	/** Emoji shown in badge + footer bullet (e.g. "⚠", "🍪", "📖"). */
	icon: string;
	/** Compact label shown in badge (e.g. "bot detection", "consent", "reddit"). */
	shortName: string;
	/** Domain name(s) this site guide applies to. Pattern guides leave this empty. */
	domains?: string[];
	/** Pattern guides only: signal that triggers this guide (e.g. "botDetected", "dialogDetected"). */
	triggerSignal?: "botDetected" | "dialogDetected";
}

/** An applicable guide for the current page, with presentation fields copied. */
export interface ApplicableGuide {
	/** Guide lookup key (e.g. "reddit", "bot-detection"). */
	name: string;
	/** Emoji from the underlying Guide. */
	icon: string;
	/** Compact label from the underlying Guide. */
	shortName: string;
	/** One-line reason this guide applies, shown in the footer bullet. */
	reason: string;
	/** Category from the underlying Guide. */
	category: GuideCategory;
}

/**
 * Sort applicable guides: patterns before sites, alphabetical within each category.
 */
export function sortApplicableGuides(
	guides: ApplicableGuide[],
): ApplicableGuide[] {
	return [...guides].sort((a, b) => {
		if (a.category !== b.category) return a.category === "pattern" ? -1 : 1;
		return a.shortName.localeCompare(b.shortName);
	});
}

// ═══════════════════════════════════════════════════════════════════
// Builtin Guides
// ═══════════════════════════════════════════════════════════════════

export const BUILTIN_GUIDES: Record<string, Guide> = {
	"bot-detection": {
		category: "pattern",
		source: "builtin",
		updated: "2026-06-13",
		icon: "⚠",
		shortName: "bot detection",
		triggerSignal: "botDetected",
		content: [
			"## Bot Detection Patterns",
			"",
			"### When You See a Challenge Page",
			'- Cloudflare: "Just a moment..." or "Checking your browser" — wait 5–10 seconds, some challenges auto-resolve after JavaScript execution',
			"- After waiting, take a fresh `browser-snapshot` to see if the real page loaded",
			"- If still blocked, try `web-fetch` on the same URL — it doesn't execute JS challenges and sometimes succeeds where the browser doesn't",
			"- If both fail, the site is blocking automation and cannot be accessed",
			"",
			"### What NOT to Do",
			"- Don't try to click through CAPTCHA challenges — automated clicks are fingerprinted and often cause permanent blocks",
			"- Don't retry navigation rapidly — rate limits escalate the challenge difficulty",
			"- Don't assume the page is broken — use `read` on the auto-captured screenshot path shown in the navigate output",
			"",
			"### Backend Strategy",
			"- The default `chromium` / `firefox` backends are detected by many anti-automation systems",
			'- A stealth browser backend may be available — the `browser-navigate` `strategy` parameter lists the registered backend names; retry with a stealth backend name listed there (e.g. `strategy="camoufox"`) if the default is blocked',
			"",
			"### Verifying the Page After a Challenge",
			'- Use `browser-inspect role="dialog"` to check if a challenge dialog is still present — cheaper than a full snapshot',
			"- If the dialog is gone, use `browser-inspect text=true` to read the actual page content",
			"- If `browser-inspect` shows stale refs, take a fresh `browser-snapshot`",
			"",
			"_Last verified against common Cloudflare and Akamai challenge patterns. If the described elements don't appear, fall back to `browser-inspect` and `browser-snapshot` (which includes a screenshot path) to discover the current page structure._",
		].join("\n"),
	},

	"cookie-consent": {
		category: "pattern",
		source: "builtin",
		updated: "2026-06-12",
		icon: "🍪",
		shortName: "consent",
		triggerSignal: "dialogDetected",
		content: [
			"## Cookie Consent Patterns",
			"",
			"### Common Dialog Indicators",
			'- role="dialog" or role="alertdialog" at the top of the accessibility tree',
			'- Buttons containing "Accept All", "Reject All", "Decline", "Manage"',
			"- Pressing Escape dismisses many consent dialog variants",
			'- Use `browser-inspect role="dialog"` to quickly check if a dialog is present without loading a full snapshot',
			"",
			"### Navigation After Dismissal",
			'- After dismissing consent, use `browser-inspect role="dialog"` to confirm the dialog is gone — cheaper than a full snapshot',
			"- If `browser-inspect` shows stale refs, take a fresh `browser-snapshot`",
			"- Some sites reload; others hide the dialog client-side. Either way, verify before interacting with page content",
		].join("\n"),
	},

	pagination: {
		category: "pattern",
		source: "builtin",
		updated: "2026-06-12",
		icon: "📄",
		shortName: "pagination",
		content: [
			"## Pagination Patterns",
			"",
			"### Common Patterns",
			'- "Next" or "→" button is role="button" or role="link"',
			'- Page numbers may be role="list" with role="listitem" per page',
			"- Infinite scroll: use `browser-scroll` to load more content",
			"- After scrolling, take a fresh snapshot — new elements may appear",
			"",
			"### Progressive Loading",
			"- Use `browser-inspect text=true maxChars=500` for an initial scan of page content, then `maxChars=0` for the full text after confirming content has loaded",
			'- Use `browser-inspect role="button" name="next"` to find pagination controls without loading the full tree',
			"- After scrolling, wait briefly before taking snapshot (content may still be loading)",
		].join("\n"),
	},

	search: {
		category: "pattern",
		source: "builtin",
		updated: "2026-06-12",
		icon: "🔍",
		shortName: "search",
		content: [
			"## Search Patterns",
			"",
			"### Common Patterns",
			'- Search bar is role="searchbox" or role="combobox"',
			'- Keyboard shortcut "/" focuses search on many sites (use `browser-press`)',
			"- Results may load in-page (SPA) or via navigation",
			"",
			"### After Searching",
			"- Use `browser-inspect text=true` to read search results with @e refs, rather than loading a full snapshot",
			'- Results are often role="list" with role="listitem" per result',
			"- Pagination controls follow the patterns in the pagination guide",
		].join("\n"),
	},
};

// ═══════════════════════════════════════════════════════════════════
// File Loader (user-authored guides)
// ═══════════════════════════════════════════════════════════════════

/**
 * Directory for user-authored web navigation guides.
 * Lives under the portal-owned subtree so it survives package upgrades
 * and is user-writable. No shipped site guides exist in the package —
 * all curated patterns are in BUILTIN_GUIDES (code).
 *
 * Users who git-track this directory for version control should be aware:
 * only top-level .md files with valid YAML frontmatter are loaded;
 * directories (.git/, subfolders) and non-markdown files are safely skipped.
 */
export const USER_GUIDES_DIR = join(PORTAL_DATA_DIR, "web-guides");

/**
 * Parse a raw guide file content string with YAML frontmatter.
 * Separated from the file-reader for testability.
 */
export function parseGuideContent(
	raw: string,
	filename: string,
): [string, Guide] | null {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return null;

	const [, frontmatter, content] = match;
	if (frontmatter === undefined || content === undefined) return null;

	const meta: Record<string, string> = {};
	for (const line of frontmatter.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (key) meta[key] = value;
	}

	const name = filename.replace(/\.md$/, "");
	const category = meta["category"] === "pattern" ? "pattern" : "site";
	const updated = meta["updated"] ?? new Date().toISOString().slice(0, 10);

	const icon = meta["icon"] ?? "📖";
	const shortName = meta["shortName"] ?? name;

	let triggerSignal: "botDetected" | "dialogDetected" | undefined;
	if (meta["trigger.signal"]) {
		triggerSignal = meta["trigger.signal"] as "botDetected" | "dialogDetected";
	}

	const rawDomains = meta["domains"];
	const domains: string[] | undefined = rawDomains
		? rawDomains
				.split(",")
				.map((d) => d.trim())
				.filter(Boolean)
		: undefined;

	return [
		name,
		{
			category,
			source: "user" as GuideSource,
			updated,
			icon,
			shortName,
			content: content.trim(),
			...(domains ? { domains } : {}),
			...(triggerSignal ? { triggerSignal } : {}),
		},
	];
}

/** Parse a user guide .md file with YAML frontmatter. */
export function parseGuideFile(
	filepath: string,
	filename: string,
): [string, Guide] | null {
	try {
		const raw = readFileSync(filepath, "utf-8");
		return parseGuideContent(raw, filename);
	} catch {
		return null;
	}
}

/** Load user-authored guides from web-guides/ directory. */
export function loadUserGuides(): Record<string, Guide> {
	const result: Record<string, Guide> = {};
	try {
		if (!existsSync(USER_GUIDES_DIR)) return result;
		const entries = readdirSync(USER_GUIDES_DIR);
		for (const filename of entries) {
			// Only top-level .md files. Directories (.git/, subfolders) and
			// non-markdown files are skipped — safe for users who git-track
			// this directory for version control.
			if (!filename.endsWith(".md")) continue;
			const filepath = join(USER_GUIDES_DIR, filename);
			if (!statSync(filepath).isFile()) continue;
			const parsed = parseGuideFile(filepath, filename);
			if (parsed) {
				const [name, guide] = parsed;
				result[name] = guide;
			}
		}
	} catch {
		// web-guides/ dir may not exist or be unreadable — degrade gracefully
	}
	return result;
}

// ── Merged Guide Content (lazy) ────────────────────────────────

let _guideContentCache: Record<string, Guide> | null = null;

/**
 * Get the merged guide content (builtin + user-authored).
 * Lazily built on first call; invalidate via invalidateGuideContent().
 * User-authored guides override builtin guides on name collision.
 */
export function getGuideContent(): Record<string, Guide> {
	if (!_guideContentCache) {
		_guideContentCache = {
			...BUILTIN_GUIDES,
			...loadUserGuides(),
		};
	}
	return _guideContentCache;
}

/** Invalidate the guide content cache so the next getGuideContent() call rescans guides/. */
export function invalidateGuideContent(): void {
	_guideContentCache = null;
}

/**
 * Override the guide content cache for testing.
 * Pass undefined/null to reset to default (same as invalidateGuideContent).
 * @internal
 */
export function _setGuideContentForTest(content?: Record<string, Guide>): void {
	_guideContentCache = content ?? null;
}

/** Format guide listing grouped by category, with icon/shortName and trigger info. */
export function formatGuideList(): string {
	const sites: string[] = [];
	const patterns: string[] = [];

	for (const [name, g] of Object.entries(getGuideContent())) {
		const trigger = g.triggerSignal
			? ` — ${g.icon} ${g.shortName}, fires on ${g.triggerSignal}`
			: "";
		const entry = `  ${name} (${g.source}, updated ${g.updated})${trigger}`;
		if (g.category === "site") {
			sites.push(entry);
		} else {
			patterns.push(entry);
		}
	}

	return [
		"Available guides:\n",
		"Site guides:",
		...sites.sort(),
		"",
		"Pattern guides:",
		...patterns.sort(),
		"",
		'Source: "builtin" = shipped with extension, "user" = loaded from ~/.pi/agent/pi-lean-portal/web-guides/.',
		'Call web-guide guide="<name>" for guidance.',
	].join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Stateless Guide Resolution
// ═══════════════════════════════════════════════════════════════════

/** Signal → reason string for pattern guide matching. */
const SIGNAL_REASONS: Record<"botDetected" | "dialogDetected", string> = {
	botDetected: "challenge page detected",
	dialogDetected: "consent dialog detected",
};

/**
 * Resolve all applicable guides for a navigate result.
 *
 * Stateless — no per-task suppression. Returns all matching guides.
 * Pattern triggers (bot-detection, cookie-consent) are evaluated first,
 * followed by domain site-guide lookup.
 */
export function resolveApplicableGuides(
	url: string,
	dialogDetected: boolean,
	botDetected: boolean,
): ApplicableGuide[] {
	const result: ApplicableGuide[] = [];
	const content = getGuideContent();

	// 1. Pattern guides by trigger signal
	for (const [name, guide] of Object.entries(content)) {
		if (guide.triggerSignal === "botDetected" && botDetected) {
			result.push({
				name,
				icon: guide.icon,
				shortName: guide.shortName,
				reason: SIGNAL_REASONS["botDetected"],
				category: "pattern",
			});
		} else if (guide.triggerSignal === "dialogDetected" && dialogDetected) {
			result.push({
				name,
				icon: guide.icon,
				shortName: guide.shortName,
				reason: SIGNAL_REASONS["dialogDetected"],
				category: "pattern",
			});
		}
	}

	// 2. Domain site guides
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		// Invalid URL — pattern results still returned, domain lookup skipped
		return sortApplicableGuides(result);
	}

	const guideName = buildDomainMap()[hostname];
	if (guideName) {
		const guide = content[guideName];
		if (guide) {
			result.push({
				name: guideName,
				icon: guide.icon,
				shortName: guide.shortName,
				reason: `site guide for ${hostname}`,
				category: guide.category,
			});
		}
	}

	return sortApplicableGuides(result);
}

/**
 * Format the guide footer appended to navigate output.
 *
 * Input must be pre-sorted via sortApplicableGuides() (patterns before sites,
 * alphabetical within each). Returns "" when no guides are applicable.
 */
export function formatGuideFooter(guides: ApplicableGuide[]): string {
	if (guides.length === 0) return "";

	const lines: string[] = [
		"📖 Guides available for this page — call web-guide to review before interacting (once each per conversation):",
	];

	let addedSiteHeader = false;
	for (const g of guides) {
		if (g.category === "site" && !addedSiteHeader) {
			lines.push("  Site:");
			addedSiteHeader = true;
		}
		lines.push(`  • ${g.icon} ${g.shortName} — ${g.reason}`);
	}

	return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Dynamic Domain Map
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a domain map (hostname → guide name) from all guides returned
 * by getGuideContent() that have a `domains` field.
 * Derives from the single source of truth (getGuideContent).
 */
export function buildDomainMap(): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [name, guide] of Object.entries(getGuideContent())) {
		if (
			guide.category === "site" &&
			guide.domains &&
			guide.domains.length > 0
		) {
			for (const domain of guide.domains) {
				map[domain] = name;
			}
		}
	}
	return map;
}
