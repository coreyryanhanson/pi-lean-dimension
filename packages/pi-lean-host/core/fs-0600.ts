import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Write a JSON file 0600 atomically: lazy mkdir of the parent + tmp file +
 *  rename (atomic on POSIX), so a crash mid-write can't shred the file's
 *  existing entries. Shared by the secrets and OAuth token stores. */
export function writeJson0600(p: string, data: unknown): void {
	if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(tmp, 0o600); // guard against umask overriding the mode
	} catch {
		// best-effort; rename still proceeds
	}
	renameSync(tmp, p);
}

/** Read a JSON file as a string-keyed object. Missing/corrupt/non-object
 *  (incl. array) file → {}. Read-side counterpart of writeJson0600, shared
 *  by the secrets and OAuth token stores. */
export function readJsonObject(p: string): Record<string, unknown> {
	if (!existsSync(p)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
