/**
 * Minimal guide-loader vendored from pi-lean-portal's guides.ts.
 *
 * Provides the shared projection slice: Guide type and domain-map
 * building. Host's richer ApiGuide type and its YAML-nested parser live
 * in core/parse-api-guide.ts.
 *
 * No portal dependency — this file is a verbatim-ish copy of the shared
 * slice from portal's guides.ts, stripped of portal-specific imports
 * and the builtin-guide catalog.
 */

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type GuideCategory = "site" | "pattern";
export type GuideSource = "builtin" | "user";
/** Presentation-ordering hint on the projection slice. Defaults to "web". */
export type GuideKind = "web" | "api";

/**
 * Minimal Guide type — the shared projection slice.
 *
 * Host's full ApiGuide extends this with recipe fields
 * (apiHost, operations, auth, pagination, responseShape, etc.).
 */
export interface Guide {
	/** Markdown guidance text. */
	content: string;
	/** ISO date of last update. */
	updated: string;
	category: GuideCategory;
	source: GuideSource;
	/** Emoji shown in badge + footer bullet. */
	icon: string;
	/** Compact label shown in badge. */
	shortName: string;
	/** Domain name(s) this site guide applies to. */
	domains?: string[];
	/** Pattern guides only: signal that triggers this guide. */
	triggerSignal?: "botDetected" | "dialogDetected";
	/** Presentation-ordering hint ("web" | "api"); omitted = "web". */
	kind?: GuideKind;
}

// ═══════════════════════════════════════════════════════════════════
// Domain map
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a domain map (hostname → guide names) from a guides record.
 *
 * Multi-valued: a hostname may be claimed by more than one guide (one
 * domain, multiple APIs). Mirrors portal's `buildDomainMap` shape so the
 * disambiguation surface can list every matching guide instead of
 * last-write-wins. The array preserves load (insertion) order.
 */
export function buildDomainMap(
	guides: Record<string, Guide>,
): Record<string, string[]> {
	const map: Record<string, string[]> = {};
	for (const [name, guide] of Object.entries(guides)) {
		if (
			guide.category === "site" &&
			guide.domains &&
			guide.domains.length > 0
		) {
			for (const domain of guide.domains) {
				const existing = map[domain];
				if (existing) {
					existing.push(name);
				} else {
					map[domain] = [name];
				}
			}
		}
	}
	return map;
}
