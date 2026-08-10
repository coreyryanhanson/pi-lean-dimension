/**
 * Guide store — loads and caches user-authored API guides.
 *
 * Provides the lookup primitives that `api-guide`, `api-fetch`, and
 * `api-learn` tools share. Caches per session; call `invalidateCache()`
 * after a write operation so the next read picks up the new guide.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
	loadApiGuidesFromDir,
	formatApiGuideCatalog,
} from "./parse-api-guide.js";
import { buildDomainMap } from "./guide-loader.js";
import type { ApiGuide, LoadedApiGuides } from "./api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Directory resolution
// ═══════════════════════════════════════════════════════════════════

let _userGuidesDir = join(
	homedir(),
	".pi",
	"agent",
	"pi-lean-host",
	"api-guides",
);

/** Cache — null = dirty. */
let _cache: {
	loaded: LoadedApiGuides;
	domainMap: Record<string, string[]>;
} | null = null;

// ═══════════════════════════════════════════════════════════════════
// Public API — override hooks for testing
// ═══════════════════════════════════════════════════════════════════

export function getUserGuidesDir(): string {
	return _userGuidesDir;
}

export function setUserGuidesDir(dir: string): void {
	_userGuidesDir = dir;
	_cache = null;
}

export function invalidateCache(): void {
	_cache = null;
}

/**
 * Reject a `domain` that could escape the guides dir via path traversal.
 *
 * Domains are used in `join(guidesDir, domain, ...)` for helper lookups
 * and guide writes. A user-typed `/api helpers ../../foo` or an agent
 * `api-learn({domain: "../x"})` must not read or write outside the
 * guides dir. Returns the domain if safe, throws otherwise.
 */
export function assertSafeDomain(domain: string): string {
	// A safe domain is a single path segment: no separators, no NUL,
	// and not "."/".." (self/parent). Anything else is a literal dir name.
	if (
		domain.length === 0 ||
		domain.includes("/") ||
		domain.includes("\\") ||
		domain.includes("\0") ||
		domain === "." ||
		domain === ".."
	) {
		throw new Error(
			`Invalid domain '${domain}': must be a single path segment with no '/', '\\', or '..'.`,
		);
	}
	return domain;
}

// ═══════════════════════════════════════════════════════════════════
// Internal load
// ═══════════════════════════════════════════════════════════════════

function load(): {
	loaded: LoadedApiGuides;
	domainMap: Record<string, string[]>;
} {
	if (_cache) return _cache;

	const user = loadApiGuidesFromDir(_userGuidesDir);

	const loaded: LoadedApiGuides = {
		guides: user.guides,
		malformed: user.malformed,
	};
	const domainMap = buildDomainMap(user.guides);

	_cache = { loaded, domainMap };
	return _cache;
}

// ═══════════════════════════════════════════════════════════════════
// Public lookup API
// ═══════════════════════════════════════════════════════════════════

export function loadAllGuides(): LoadedApiGuides {
	return load().loaded;
}

export function findGuidesByDomain(
	domain: string,
): { guide: ApiGuide; dirName: string }[] {
	const { loaded, domainMap } = load();
	const names = domainMap[domain];
	if (!names) return [];
	const out: { guide: ApiGuide; dirName: string }[] = [];
	for (const name of names) {
		const guide = loaded.guides[name];
		if (guide) out.push({ guide, dirName: name });
	}
	return out;
}

export function getCatalogText(): string {
	return formatApiGuideCatalog(load().loaded);
}
