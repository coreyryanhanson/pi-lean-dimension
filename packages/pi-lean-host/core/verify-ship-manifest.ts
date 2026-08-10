/**
 * Ship-manifest verification helper (vendored from pi-lean-portal).
 *
 * Walks a package directory for production `.ts` files and compares them to
 * the `files` array in `package.json`. Used by `ship-manifest.test.ts` to
 * prove the published npm tarball contains every module the package imports
 * at runtime — with a negative assertion that `api-guides/` and helper .ts
 * files are absent (GitHub-only recipes).
 *
 * Vendored (not imported from portal) so the host-only boundary stays intact.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SKIP_DIRS = ["node_modules", "docs", "__tests__"];
const SKIP_FILES = new Set<string>(["test-fixtures.ts"]);
/** Entries that won't exist on disk at rest but are valid (generated at pack time). */
const SKIP_STALE = new Set(["LICENSE"]);

export interface ShipManifestResult {
	declared: readonly string[];
	onDisk: readonly string[];
	missing: readonly string[];
	stale: readonly string[];
}

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
			`verifyShipManifest: invalid package.json under "${packageDir}": ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const dirPrefixes: string[] = [];
	for (const entry of declared) {
		if (entry.startsWith("!")) continue;
		if (entry.endsWith("/")) dirPrefixes.push(entry);
		else if (isDirOnDisk(packageDir, entry)) dirPrefixes.push(`${entry}/`);
		else exactFiles.add(entry);
	}

	const onDisk = walkProductionTs(packageDir, packageDir, skipDirs);
	const missing = onDisk.filter((f) => !isCovered(f, exactFiles, dirPrefixes));
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
