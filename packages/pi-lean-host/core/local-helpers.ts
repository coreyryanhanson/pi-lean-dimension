/**
 * Local user helpers — `import()`-loaded transform modules.
 *
 * User-authored TypeScript helpers live alongside their guide in a per-domain
 * subdirectory: `~/.pi/agent/pi-lean-host/api-guides/<domain>/helper.ts`.
 * They are loaded on demand via dynamic `import()` when an API guide's
 * operation sets `helper: true`. A load failure (syntax error, missing
 * dep, top-level throw) or execution throw disables the helper for the
 * rest of the session.
 *
 * One helper per domain is the v1 contract.
 *
 * Helper contract:
 * ```ts
 * export default function(
 *   params: Record<string, unknown>,
 *   ctx: { operation: string; domain: string },
 * ): Record<string, unknown> | Promise<Record<string, unknown>>;
 * ```
 *
 * The helper is a **pre-call transform**: it receives the agent-supplied
 * params and returns the params the executor should use for URL
 * templating / query assembly.  It must be synchronous-pure or
 * fully-awaited — no background work (setTimeout/setInterval/process.on
 * callbacks escape as uncaughtException and cannot be caught here).
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { getUserGuidesDir } from "./guide-store.js";
import { assertSafeDomain } from "./path-template.js";

// ═══════════════════════════════════════════════════════════════════
// Session-level state
// ═══════════════════════════════════════════════════════════════════

const disabledHelpers = new Map<string, true>();

// ═══════════════════════════════════════════════════════════════════
// Test hooks
// ═══════════════════════════════════════════════════════════════════

export function resetDisabledHelpers(): void {
	disabledHelpers.clear();
}

// ═══════════════════════════════════════════════════════════════════
// Internal — resolve a helper file path under the guides dir
// ═══════════════════════════════════════════════════════════════════

/** Find an existing helper file for the domain, or null. */
function findHelperFile(domain: string): string | null {
	assertSafeDomain(domain);
	const guidesDir = getUserGuidesDir();
	for (const ext of [".ts", ".mjs", ".js"] as const) {
		const candidate = join(guidesDir, domain, `helper${ext}`);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/** Helper transform function type. */
export type HelperFn = (
	params: Record<string, unknown>,
	ctx: { operation: string; domain: string },
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Post-response transform function type — the named `transform` export of a
 * guide's helper.ts. Receives the parsed response body and returns the shaped
 * data. Must be synchronous-pure or fully awaited (same constraint as the
 * pre-call helper).
 *
 * `ctx.domain` is the matched guide's `dirName`, not the routing `domain` —
 * the same value api-fetch threads into the pre-call `callHelper`.
 */
export type TransformFn = (
	data: unknown,
	ctx: { operation: string; domain: string },
) => unknown;

/** Result of calling a helper — either transformed params or an error. */
export type CallHelperResult =
	| { ok: true; params: Record<string, unknown> }
	| { ok: false; error: string; disabled: boolean };

/**
 * List all persisted helper domains (domain subdirs with a helper.ts).
 */
export function getAllHelpers(): string[] {
	const guidesDir = getUserGuidesDir();
	if (!existsSync(guidesDir)) return [];
	const result: string[] = [];
	for (const entry of readdirSync(guidesDir)) {
		const entryPath = join(guidesDir, entry);
		try {
			if (!statSync(entryPath).isDirectory()) continue;
		} catch {
			continue;
		}
		// Check for helper.ts (or .mjs / .js fallback for tests)
		for (const ext of [".ts", ".mjs", ".js"] as const) {
			if (existsSync(join(entryPath, `helper${ext}`))) {
				result.push(entry);
				break;
			}
		}
	}
	return result;
}

/**
 * Read a helper's source for display.
 */
export function readHelperSource(domain: string): string | null {
	const filePath = findHelperFile(domain);
	if (!filePath) return null;
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Return the list of disabled helper domains.
 */
export function getDisabledHelperDomains(): string[] {
	return Array.from(disabledHelpers.keys());
}

/**
 * Load a helper module, returning the default export if present.
 * Returns null when the helper file doesn't exist, is already disabled,
 * or failed to load (in which case it marks it disabled).
 */
async function loadHelper(domain: string): Promise<HelperFn | null> {
	if (disabledHelpers.has(domain)) return null;

	let filePath: string | null;
	try {
		filePath = findHelperFile(domain);
	} catch {
		// assertSafeDomain rejected a traversal domain — treat as unloadable.
		disabledHelpers.set(domain, true);
		return null;
	}
	if (!filePath) return null;

	try {
		const fileUrl = pathToFileURL(filePath).href;
		const mod = await import(fileUrl);

		if (typeof mod.default !== "function") {
			disabledHelpers.set(domain, true);
			return null;
		}

		return mod.default as HelperFn;
	} catch {
		disabledHelpers.set(domain, true);
		return null;
	}
}

/**
 * Load a guide's named `transform` export (post-response), or null.
 *
 * Load-only — does not invoke the transform (the executor hookpoint owns the
 * invocation and its try/catch). Reuses the pre-call helper's file resolution
 * (`findHelperFile`, `.ts` → `.mjs` → `.js`). Returns null when the file is
 * missing, the named export is absent, or the module fails to load. No
 * disable map: each call re-`import()`s (a successful load is a Node module
 * cache hit) and re-attempts, per the design's graceful no-disable contract.
 */
export async function loadTransform(
	dirName: string,
): Promise<TransformFn | null> {
	let filePath: string | null;
	try {
		filePath = findHelperFile(dirName);
	} catch {
		// assertSafeDomain rejected a traversal domain — treat as unloadable.
		return null;
	}
	if (!filePath) return null;

	try {
		const fileUrl = pathToFileURL(filePath).href;
		const mod = await import(fileUrl);
		if (typeof mod.transform !== "function") return null;
		return mod.transform as TransformFn;
	} catch {
		return null;
	}
}

/**
 * Call a helper for the given domain and operation.
 *
 * Returns transformed params on success, raw params when no helper file
 * exists (passthrough), or an error result when the helper is disabled
 * or throws.
 */
export async function callHelper(
	domain: string,
	operationName: string,
	params: Record<string, unknown>,
): Promise<CallHelperResult> {
	const helper = await loadHelper(domain);

	if (helper === null) {
		if (disabledHelpers.has(domain)) {
			return {
				ok: false,
				disabled: true,
				error:
					`Helper '${domain}' is disabled for this session after a load or execution failure. ` +
					`Fix the helper file and restart the session.`,
			};
		}
		// No helper file exists — passthrough unchanged.
		return { ok: true, params };
	}

	try {
		const ctx = { operation: operationName, domain };
		const result = await helper(params, ctx);
		return { ok: true, params: result };
	} catch {
		disabledHelpers.set(domain, true);
		return {
			ok: false,
			disabled: true,
			error:
				`Helper '${domain}' threw during execution and has been disabled for this session. ` +
				`Fix the helper file and restart the session.`,
		};
	}
}
