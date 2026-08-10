/**
 * Shared recipe-setup harness for co-located guide tests.
 *
 * Layer 1 only: temp-dir plumbing. Copies guide folders into a throwaway dir
 * so the real `apiFetch` pipeline runs against an isolated user-guides dir.
 * This is the part that is byte-for-byte identical across every guide's
 * tests; it never touches any API.
 *
 * Layer 2 — the `fetchOp` wrapper + per-op assertions — stays per-file. The
 * wrapper encodes domain-specific shape (delay, 503-retry, auth overlay) and
 * cannot be shared. But the bare bootstrap (load recipe, dispatch on `via`) is
 * generic and lives here as `createFetchOp`; per-file wrappers compose around it.
 *
 * Not under `core/`: this is peer test plumbing, not framework code. A guide
 * imports it via a relative path (`../_shared/test-harness.js`); base code
 * never imports it.
 */

import {
	mkdtempSync,
	mkdirSync,
	copyFileSync,
	readdirSync,
	statSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import type { TransformFn } from "../../core/local-helpers.js";

const _dirname = dirname(fileURLToPath(import.meta.url));
// _shared/ lives one level under api-guides/, so the guides root is its parent.
const REPO_API_GUIDES = join(_dirname, "..");

function copyDir(src: string, dest: string): void {
	if (!existsSync(src)) return;
	const entries = readdirSync(src);
	mkdirSync(dest, { recursive: true });
	for (const entry of entries) {
		const srcPath = join(src, entry);
		const destPath = join(dest, entry);
		if (statSync(srcPath).isDirectory()) {
			copyDir(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

function copyDomains(guidesDir: string, ...domains: string[]): void {
	for (const domain of domains) {
		const src = join(REPO_API_GUIDES, domain);
		if (!existsSync(src)) throw new Error(`Recipe folder not found: ${src}`);
		copyDir(src, join(guidesDir, domain));
	}
}

export interface TempDirs {
	guidesDir: string;
}

const HOST_INTEGRATION = process.env["HOST_INTEGRATION"] === "1";

/** Live-gate: runs the test only under HOST_INTEGRATION=1, else it.skip. */
export const itWhen = (HOST_INTEGRATION ? it : it.skip) as typeof it;

/**
 * Generic fetchOp bootstrap: load the recipe from `guidesDir`, find the named
 * op, and dispatch on the op's own `via` (restGet | paginate). Encodes no
 * domain shape. For delay/retry/auth-overlay, compose a per-file wrapper
 * around the returned function — do NOT add options here.
 */
export function createFetchOp(
	domain: string,
): (
	guidesDir: string,
	name: string,
	params?: Record<string, unknown>,
) => Promise<unknown> {
	return async (guidesDir, name, params = {}) => {
		const { restGet, paginate } = await import("../../core/helpers.js");
		const { setUserGuidesDir, findGuidesByDomain } = await import(
			"../../core/guide-store.js"
		);
		setUserGuidesDir(guidesDir);
		// Resolve like the real api-fetch tool: every guide claiming `domain`,
		// then the op by name across all matches (multi-recipe safe).
		const match = findGuidesByDomain(domain).find(({ guide }) =>
			guide.operations.some((o) => o.name === name),
		)!;
		const op = match.guide.operations.find((o) => o.name === name)!;
		// Mirror api-fetch's transform wiring: when the op declares
		// `transform: true`, load the named `transform` export from the
		// matched guide's helper.ts and pass it into the executor. Without
		// this, a transform-adopting op run through the harness would return
		// raw data and the live assertions would be a silent lie.
		let transformFn: TransformFn | null = null;
		if (op.transform === true) {
			const { loadTransform } = await import("../../core/local-helpers.js");
			transformFn = await loadTransform(match.dirName);
		}
		const passTransform = transformFn ?? undefined;
		return op.via === "paginate"
			? paginate(
					match.guide.apiHost,
					op,
					params,
					match.guide,
					undefined,
					passTransform,
					match.dirName,
				)
			: restGet(
					match.guide.apiHost,
					op,
					params,
					match.guide,
					undefined,
					passTransform,
					match.dirName,
				);
	};
}

/**
 * Wrap a test body in temp-dir setup/teardown. Pass the domains to copy in.
 * Returns a zero-arg async fn suitable for `it(..., harness("boe.es")(async ({ guidesDir }) => { ... }))`.
 *
 * No-op (returns immediately) when `HOST_INTEGRATION !== "1"`, so bare CI
 * skips the live path without touching the filesystem.
 */
export function withTempDirs(
	...domainsToCopy: string[]
): (fn: (dirs: TempDirs) => Promise<void>) => () => Promise<void> {
	const HOST_INTEGRATION = process.env["HOST_INTEGRATION"] === "1";
	return (fn: (dirs: TempDirs) => Promise<void>) => {
		return async () => {
			if (!HOST_INTEGRATION) return;
			const guidesDir = mkdtempSync(join(tmpdir(), "pi-host-smoke-guides-"));
			try {
				copyDomains(guidesDir, ...domainsToCopy);
				await fn({ guidesDir });
			} finally {
				rmSync(guidesDir, { recursive: true, force: true });
			}
		};
	};
}
