/**
 * Web Navigation Guides
 *
 * Three-tier auto-presence (auto-inject / auto-hint / on-demand) that
 * appends navigation guidance to browser-navigate output. Supports
 * builtin guides (shipped with the extension) and user-authored guides
 * (loaded from the guides/ directory).
 *
 * Types, data, file loader, presence resolution, and cleanup are all
 * in this single file.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readMergedSettings } from "./shared/settings-reader.js";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type GuideCategory = "site" | "pattern";
export type GuideSource = "builtin" | "user";

export interface GuideTrigger {
	/** Which navigate-result signal to check. */
	signal: "botDetected" | "dialogPresent";
	/** How to surface the guide when the signal fires. */
	presence: "inject" | "hint";
}

export interface Guide {
	/** Markdown guidance text (≤800 chars recommended). */
	content: string;
	/** ISO date of last update. */
	updated: string;
	category: GuideCategory;
	source: GuideSource;
	/** Domain name(s) this site guide applies to. Pattern guides leave this empty. */
	domains?: string[];
	/** Pattern guides only; site guides use domains or DOMAIN_MAP. */
	trigger?: GuideTrigger;
}

/** Domain mapping entry — maps a hostname to a guide and optional backend strategy. */
export interface DomainEntry {
	/** Guide name for lookup in GUIDE_CONTENT. */
	guide?: string;
	/** Suggested backend strategy (reserved for stealth). */
	strategy?: string;
}

/** Result of guide presence resolution. */
export type GuidePresenceType = "inject" | "hint";

export interface GuidePresenceResult {
	type: GuidePresenceType;
	guideName: string;
	text: string;
}

// ═══════════════════════════════════════════════════════════════════
// Domain Map
// ═══════════════════════════════════════════════════════════════════

export const DOMAIN_MAP: Record<string, DomainEntry> = {
	"_internal-test.example": { guide: "_builtin-test-fixture" },
};

// ═══════════════════════════════════════════════════════════════════
// Builtin Guides
// ═══════════════════════════════════════════════════════════════════

export const BUILTIN_GUIDES: Record<string, Guide> = {
	"bot-detection": {
		category: "pattern",
		source: "builtin",
		updated: "2026-06-13",
		trigger: { signal: "botDetected", presence: "inject" },
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
			"- Don't assume the page is broken — `browser-screenshot` can show you what's actually rendered",
			"",
			"### Backend Strategy",
			"- The default `chromium` backend is detected by many anti-automation systems",
			'- A stealth browser backend may be available — try `browser-navigate` with `strategy="stealth"` if the default backend is blocked',
			"- If no stealth backend is configured, this will fail with a clear error — no harm in trying",
			"",
			"### Verifying the Page After a Challenge",
			'- Use `browser-inspect role="dialog"` to check if a challenge dialog is still present — cheaper than a full snapshot',
			"- If the dialog is gone, use `browser-inspect text=true` to read the actual page content",
			"- If `browser-inspect` shows stale refs, take a fresh `browser-snapshot`",
			"",
			"_Last verified against common Cloudflare and Akamai challenge patterns. If the described elements don't appear, fall back to `browser-inspect` and `browser-screenshot` to discover the current page structure._",
		].join("\n"),
	},

	"cookie-consent": {
		category: "pattern",
		source: "builtin",
		updated: "2026-06-12",
		trigger: { signal: "dialogPresent", presence: "hint" },
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

	"_builtin-test-fixture": {
		category: "site",
		source: "builtin",
		updated: "2026-06-13",
		content: [
			"## Builtin Test Fixture",
			"",
			"This is a test-only builtin site guide. It ships with the extension solely to",
			"exercise the domain-hint auto-presence code path. No real website guidance",
			"is provided here.",
			"",
			"To add your own site guides, place a `.md` file with YAML frontmatter in the",
			"`guides/` directory — see the web-guide tool or AGENTS.md for details.",
		].join("\n"),
	},
};

// ═══════════════════════════════════════════════════════════════════
// File Loader (user-authored guides)
// ═══════════════════════════════════════════════════════════════════

/** Directory for user-authored guide files, resolved relative to this file (core/ → ../guides/). */
export const GUIDES_DIR = join(__dirname, "..", "guides");

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

	let trigger: GuideTrigger | undefined;
	if (meta["trigger.signal"] && meta["trigger.presence"]) {
		trigger = {
			signal: meta["trigger.signal"] as GuideTrigger["signal"],
			presence: meta["trigger.presence"] as GuideTrigger["presence"],
		};
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
			content: content.trim(),
			...(domains ? { domains } : {}),
			...(trigger ? { trigger } : {}),
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

/** Load user-authored guides from guides/ directory. */
export function loadUserGuides(): Record<string, Guide> {
	const result: Record<string, Guide> = {};
	try {
		if (!existsSync(GUIDES_DIR)) return result;
		const entries = readdirSync(GUIDES_DIR);
		for (const filename of entries) {
			if (!filename.endsWith(".md")) continue;
			const parsed = parseGuideFile(join(GUIDES_DIR, filename), filename);
			if (parsed) {
				const [name, guide] = parsed;
				result[name] = guide;
			}
		}
	} catch {
		// guides/ dir may not exist or be unreadable — degrade gracefully
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

/** Format guide listing grouped by category and source. */
export function formatGuideList(): string {
	const sites: string[] = [];
	const patterns: string[] = [];

	for (const [name, g] of Object.entries(getGuideContent())) {
		const entry = `  ${name} (${g.source}, updated ${g.updated})`;
		if (g.category === "site") {
			sites.push(entry);
		} else {
			const trigger = g.trigger
				? ` — auto-${g.trigger.presence} when ${g.trigger.signal}`
				: "";
			patterns.push(entry + trigger);
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
		'Source: "builtin" = shipped with extension, "user" = loaded from guides/ directory.',
		'Call web-guide guide="<name>" for guidance.',
	].join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Guide Presence Resolution
// ═══════════════════════════════════════════════════════════════════

/** Per-task suppression of auto-injected guides (Map<taskId, Set<guideName>>). */
const injectedGuides = new Map<string, Set<string>>();

// ═══════════════════════════════════════════════════════════════════
// Dynamic Domain Map
// ═══════════════════════════════════════════════════════════════════

let _domainMapCache: Record<string, DomainEntry> | null = null;

/**
 * Build a domain map from DOMAIN_MAP (static base) + all guides returned
 * by getGuideContent() that have a `domains` field.
 * Derives from the single source of truth (getGuideContent) rather than
 * calling loadUserGuides() independently — this keeps both caches consistent.
 */
export function buildDomainMap(): Record<string, DomainEntry> {
	const map: Record<string, DomainEntry> = { ...DOMAIN_MAP };
	for (const [name, guide] of Object.entries(getGuideContent())) {
		if (
			guide.category === "site" &&
			guide.domains &&
			guide.domains.length > 0
		) {
			for (const domain of guide.domains) {
				map[domain] = { guide: name };
			}
		}
	}
	return map;
}

/** Get the (cached) domain map; lazily built on first call. */
export function getDomainMap(): Record<string, DomainEntry> {
	if (!_domainMapCache) {
		_domainMapCache = buildDomainMap();
	}
	return _domainMapCache;
}

/** Invalidate the domain map cache so the next getDomainMap() call rescans. */
export function invalidateDomainMap(): void {
	_domainMapCache = null;
}

/** Check if a dialog is present in the snapshot/accessibility tree text. */
export function dialogPresentInSnapshot(snapshot: string): boolean {
	return (
		snapshot.includes('role="dialog"') ||
		snapshot.includes('role="alertdialog"')
	);
}

/**
 * Read the autoInject config from settings.json.
 * Uses the shared settings-reader module for canonical path resolution
 * and file reading — avoiding duplication of path/file logic.
 *
 * @param override - Optional override for testing. If provided, overrides file-based config.
 */
export function readGuidesConfig(override?: { autoInject: boolean }): {
	autoInject: boolean;
} {
	if (override !== undefined) return override;

	// Read global + project settings (project overrides global)
	const merged = readMergedSettings();
	const browser = merged.browser as Record<string, unknown> | undefined;
	if (
		browser &&
		typeof browser === "object" &&
		!Array.isArray(browser) &&
		(browser as any)?.guides?.autoInject === false
	) {
		return { autoInject: false };
	}
	return { autoInject: true };
}

/**
 * Resolve which guide presence to show, if any, based on the navigate result.
 *
 * Priority order:
 * 1. Bot-detection trigger (highest)
 * 2. Dialog presence trigger
 * 3. Domain-based hint
 *
 * @param configOverride - Optional config override for testing. Passed to `readGuidesConfig`.
 */
export function resolveGuidePresence(
	taskId: string,
	url: string,
	snapshot: string,
	botDetected: boolean,
	configOverride?: { autoInject: boolean },
): GuidePresenceResult | undefined {
	// Get or create per-task injection set
	let taskInjected = injectedGuides.get(taskId);
	if (!taskInjected) {
		taskInjected = new Set<string>();
		injectedGuides.set(taskId, taskInjected);
	}

	const autoInjectConfig = readGuidesConfig(configOverride).autoInject;

	// 1. Bot-detection trigger — highest priority
	if (botDetected) {
		const guide = getGuideContent()["bot-detection"];
		if (guide?.trigger?.signal === "botDetected") {
			if (autoInjectConfig && !taskInjected.has("bot-detection")) {
				taskInjected.add("bot-detection");
				return {
					type: "inject",
					guideName: "bot-detection",
					text: guide.content,
				};
			}
			return {
				type: "hint",
				guideName: "bot-detection",
				text: '⚠️ Bot detection triggered. Call web-guide guide="bot-detection" for strategies.',
			};
		}
	}

	// 2. Dialog trigger — check for consent dialogs in snapshot
	if (dialogPresentInSnapshot(snapshot)) {
		const guide = getGuideContent()["cookie-consent"];
		if (guide?.trigger?.signal === "dialogPresent") {
			return {
				type: "hint",
				guideName: "cookie-consent",
				text: '💡 A consent dialog appears to be present. Call web-guide guide="cookie-consent" for dismissal patterns.',
			};
		}
	}

	// 3. Domain-based hint — site guides via dynamic domain map
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return undefined;
	}
	const entry = getDomainMap()[hostname];
	if (entry?.guide && getGuideContent()[entry.guide]) {
		let text = `💡 A web guide is available for ${hostname}.\n   Call web-guide guide="${entry.guide}" for navigation tips.`;
		if (entry.strategy) {
			text += `\n   This site often requires a stealth browser — try strategy="${entry.strategy}".`;
		}
		return { type: "hint", guideName: entry.guide, text };
	}

	return undefined;
}

/** Clean up per-task injection tracking. */
export function cleanupInjectedGuides(taskId: string): void {
	injectedGuides.delete(taskId);
}
