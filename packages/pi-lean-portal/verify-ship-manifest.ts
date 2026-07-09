/**
 * Ship-manifest verification helper.
 *
 * Walks a package directory for production `.ts` files and compares them to
 * the `files` array in `package.json`. Used by `ship-manifest.test.ts` files
 * across the monorepo so every published package can prove its npm tarball
 * actually contains the modules it imports at runtime.
 *
 * Ported from rpiv-mono's `@juicesharp/rpiv-test-utils` pattern.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `contributed` is portal-specific: it holds backend templates (bridge.py,
// *.test.ts parity templates) that are tracked but deliberately NOT shipped in
// the npm tarball (excluded by the `files` allowlist). Skipping it structurally
// mirrors how `docs` was handled before the contributed-backends restructure,
// so a future non-test .ts helper added under contributed/ does not surface as
// `missing` and fail ship-manifest.test.ts. If a module under contributed/ is
// ever intended to ship, remove this entry or add the specific file to `files`.
const SKIP_DIRS = new Set(["node_modules", "docs", "__tests__", "contributed"]);
const SKIP_FILES = new Set(["test-fixtures.ts"]);
/** Entries that won't exist on disk at rest but are valid (generated at pack time, e.g. by prepack). */
const SKIP_STALE = new Set(["LICENSE"]);

export interface ShipManifestResult {
	/** Entries declared in `package.json` `files`. */
	declared: readonly string[];
	/** Production `.ts` files discovered on disk (relative to packageDir). */
	onDisk: readonly string[];
	/** On-disk files NOT covered by the `files` array — these would be missing from the published tarball. */
	missing: readonly string[];
	/** `files` entries with no corresponding path on disk — ghost entries that ship nothing. */
	stale: readonly string[];
}

/**
 * Verify a package's ship manifest against its on-disk production .ts tree.
 *
 * Accepts either a directory path or a `file:` URL string (so callers can
 * pass `import.meta.url` directly — the helper resolves it to the test file's
 * parent directory).
 *
 * Skips: dotfiles/dotdirs, `node_modules`, `docs`, `*.test.ts`, `test-fixtures.ts`.
 * Does NOT check: asset directories (e.g. `locales/*.json`), `exports` map,
 * `main`/`module` fields.
 *
 * The check is two-way: `missing` flags on-disk production files the tarball
 * would omit; `stale` flags `files` entries that point at nothing on disk
 * (asset entries like `README.md` count as present — staleness is plain
 * existence, not the production-`.ts` walk).
 */
export function verifyShipManifest(
	packageDirOrUrl: string,
): ShipManifestResult {
	const packageDir = packageDirOrUrl.startsWith("file:")
		? dirname(fileURLToPath(packageDirOrUrl))
		: packageDirOrUrl;
	let pkgRaw: string;
	try {
		pkgRaw = readFileSync(resolve(packageDir, "package.json"), "utf8");
	} catch (err) {
		throw new Error(
			`verifyShipManifest: could not read package.json under "${packageDir}": ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	let pkg: { files?: string[] };
	try {
		pkg = JSON.parse(pkgRaw) as { files?: string[] };
	} catch (err) {
		throw new Error(
			`verifyShipManifest: package.json under "${packageDir}" is not valid JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const dirPrefixes: string[] = [];
	for (const entry of declared) {
		// Negation patterns (`!foo/`) are npm `files`-array syntax for excluding
		// sub-paths within an included directory. They have no on-disk counterpart;
		// skip them for existence checks and staleness detection.
		if (entry.startsWith("!")) continue;
		// Treat trailing-slash entries AND bare directory names that exist on
		// disk as recursive directory inclusion — matches npm's own `files`
		// semantics so the test answers "would npm publish actually include this?"
		// rather than enforcing a stylistic preference. Bare dir names are
		// normalized to a trailing-slash prefix so a `"load"` entry covers
		// `load/cache.ts` without spuriously matching a sibling `loader.ts`.
		if (entry.endsWith("/")) dirPrefixes.push(entry);
		else if (isDirOnDisk(packageDir, entry)) dirPrefixes.push(`${entry}/`);
		else exactFiles.add(entry);
	}

	const onDisk = walkProductionTs(packageDir, packageDir);
	const missing = onDisk.filter((f) => !isCovered(f, exactFiles, dirPrefixes));
	// Staleness: check only non-negation entries. Negation patterns (`!foo/`)
	// have no on-disk counterpart.
	const stale = declared.filter(
		(entry) =>
			!entry.startsWith("!") &&
			!SKIP_STALE.has(entry) &&
			!existsSync(resolve(packageDir, entry)),
	);

	return { declared, onDisk, missing, stale };
}

function isDirOnDisk(packageDir: string, entry: string): boolean {
	try {
		return statSync(resolve(packageDir, entry)).isDirectory();
	} catch {
		// Entry not present on disk (e.g. an asset/extraneous `files` entry) —
		// not a directory we can recurse into; the caller treats it as an exact file.
		return false;
	}
}

function isCovered(
	file: string,
	exactFiles: Set<string>,
	dirPrefixes: readonly string[],
): boolean {
	if (exactFiles.has(file)) return true;
	for (const prefix of dirPrefixes) {
		if (file.startsWith(prefix)) return true;
	}
	return false;
}

function walkProductionTs(root: string, dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkProductionTs(root, abs));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || SKIP_FILES.has(entry.name)) continue;
		out.push(relative(root, abs));
	}
	return out;
}
