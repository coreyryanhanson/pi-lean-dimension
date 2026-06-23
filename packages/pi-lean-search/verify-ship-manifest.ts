/**
 * Ship-manifest verification helper.
 *
 * Walks a package directory for production `.ts` files and compares them to
 * the `files` array in `package.json`. Used by `ship-manifest.test.ts` files
 * across the monorepo so every published package can prove its npm tarball
 * actually contains the modules it imports at runtime.
 *
 * Ported from pi-lean-portal's verify-ship-manifest.ts (rpiv-mono pattern).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "docs", "__tests__"]);
const SKIP_FILES = new Set(["test-fixtures.ts"]);

export interface ShipManifestResult {
	declared: readonly string[];
	onDisk: readonly string[];
	missing: readonly string[];
	stale: readonly string[];
}

export function verifyShipManifest(
	packageDirOrUrl: string,
): ShipManifestResult {
	const packageDir = packageDirOrUrl.startsWith("file:")
		? dirname(fileURLToPath(packageDirOrUrl))
		: packageDirOrUrl;
	const pkgRaw = readFileSync(resolve(packageDir, "package.json"), "utf8");
	const pkg = JSON.parse(pkgRaw) as { files?: string[] };
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const dirPrefixes: string[] = [];
	for (const entry of declared) {
		if (entry.endsWith("/")) dirPrefixes.push(entry);
		else if (isDirOnDisk(packageDir, entry)) dirPrefixes.push(`${entry}/`);
		else exactFiles.add(entry);
	}

	const onDisk = walkProductionTs(packageDir, packageDir);
	const missing = onDisk.filter((f) => !isCovered(f, exactFiles, dirPrefixes));
	const stale = declared.filter(
		(entry) => !existsSync(resolve(packageDir, entry)),
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
