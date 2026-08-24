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
import type { ApiGuide, LoadedApiGuides, NotifyFn } from "./api-guide-types.js";

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

// Load-time diagnostics (migration banner + per-guide malformed warnings) are
// a startup concern: emit them once per pi process on the first cold scan,
// then suppress for the rest of the session so navigating chats or running
// commands doesn't re-warn. A no-op notify (not `undefined`) is what
// suppresses — `undefined` falls back to console.warn inside the loader.
let loadWarningsEmitted = false;
const suppressWarnings: NotifyFn = () => {};

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

/** @internal Reset once-per-process warning suppression (test helper). */
export function _resetLoadWarningsForTest(): void {
	loadWarningsEmitted = false;
}

// ═══════════════════════════════════════════════════════════════════
// Internal load
// ═══════════════════════════════════════════════════════════════════

function load(notify?: NotifyFn): {
	loaded: LoadedApiGuides;
	domainMap: Record<string, string[]>;
} {
	if (_cache) return _cache;

	const warnNotify = loadWarningsEmitted ? suppressWarnings : notify;
	loadWarningsEmitted = true;
	const user = loadApiGuidesFromDir(_userGuidesDir, warnNotify);

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

export function loadAllGuides(notify?: NotifyFn): LoadedApiGuides {
	return load(notify).loaded;
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
