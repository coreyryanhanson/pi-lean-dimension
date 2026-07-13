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

const DEFAULT_SKIP_DIRS = ["node_modules", "docs", "__tests__"];
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
 *
 * @param opts.skipDirs - Additional directory names to skip beyond the defaults
 *                        (`node_modules`, `docs`, `__tests__`).
 */
export function verifyShipManifest(
	packageDirOrUrl: string,
	opts?: { skipDirs?: readonly string[] },
): ShipManifestResult {
	const packageDir = packageDirOrUrl.startsWith("file:")
		? dirname(fileURLToPath(packageDirOrUrl))
		: packageDirOrUrl;
	const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(opts?.skipDirs ?? [])]);
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

	const onDisk = walkProductionTs(packageDir, packageDir, skipDirs);
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

function walkProductionTs(
	root: string,
	dir: string,
	skipDirs: Set<string>,
): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkProductionTs(root, abs, skipDirs));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || SKIP_FILES.has(entry.name)) continue;
		out.push(relative(root, abs));
	}
	return out;
}
