/**
 * Secrets store — per-domain secret name → value persistence.
 *
 * File backend: `~/.pi/agent/pi-lean-host/secrets/<domain>.json`, one flat
 * JSON object per domain keyed by secret name → value (matches the `secretName`
 * in the future `auth.secretRefs`/`auth.secretQueryRefs` schema fields).
 *
 * Security posture:
 * - Files are written 0600.
 * - The dir is created **lazily on write only**; reads/list never mkdir, so a
 *   read-only `$HOME` doesn't get a `secrets/` dir created under it.
 * - Listing surfaces names only, never values.
 *
 * The store is swappable (the `SecretStore` interface + `setStore`) so the
 * deferred OS-keychain backend is a drop-in without touching callers.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { assertSafeDomain } from "./guide-store.js";

/** A secret store: read/write/delete one name, list domain/name indexes. */
export interface SecretStore {
	read(domain: string, name: string): string | null;
	write(domain: string, name: string, value: string): void;
	delete(domain: string, name: string): void;
	deleteDomain(domain: string): void;
	listDomains(): string[];
	listNames(domain: string): string[];
}

/** Reject a secret name that isn't a clean JSON key. */
function assertSecretName(name: string): void {
	if (name.length === 0 || /[/\\\0]/.test(name)) {
		throw new Error(
			`Invalid secret name '${name}': must be a single name with no '/', '\\', or NUL.`,
		);
	}
}

/** File-backed store rooted at `dir` (one `<domain>.json` per domain). */
export function createFileStore(dir: string): SecretStore {
	const domainPath = (domain: string): string => {
		assertSafeDomain(domain);
		return join(dir, `${domain}.json`);
	};

	// Read a domain file as a flat name→value map. Missing/corrupt file → {}.
	// Never touches the filesystem's dir structure (no mkdir).
	const readFile = (domain: string): Record<string, string> => {
		const p = domainPath(domain);
		if (!existsSync(p)) return {};
		try {
			const parsed = JSON.parse(readFileSync(p, "utf-8"));
			return parsed && typeof parsed === "object"
				? (parsed as Record<string, string>)
				: {};
		} catch {
			return {};
		}
	};

	return {
		read(domain, name) {
			const value = readFile(domain)[name];
			return typeof value === "string" ? value : null;
		},
		write(domain, name, value) {
			const p = domainPath(domain); // also asserts domain safety
			assertSecretName(name);
			// Lazy mkdir on write only — never on read/list.
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const file = readFile(domain);
			file[name] = value;
			writeFileSync(p, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
			try {
				chmodSync(p, 0o600); // guard against umask overriding the mode
			} catch {
				// best-effort; file was already written
			}
		},
		delete(domain, name) {
			const p = domainPath(domain); // also asserts domain safety
			assertSecretName(name);
			if (!existsSync(p)) return;
			const file = readFile(domain);
			if (!Object.hasOwn(file, name)) return;
			delete file[name];
			if (Object.keys(file).length === 0) {
				// Prune the empty file so the domain drops out of listDomains.
				rmSync(p, { force: true });
			} else {
				writeFileSync(p, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
				try {
					chmodSync(p, 0o600);
				} catch {
					// best-effort; file was already written
				}
			}
		},
		deleteDomain(domain) {
			const p = domainPath(domain); // also asserts domain safety
			if (existsSync(p)) rmSync(p, { force: true });
		},
		listDomains() {
			if (!existsSync(dir)) return [];
			return readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -".json".length))
				.sort((a, b) => a.localeCompare(b));
		},
		listNames(domain) {
			return Object.keys(readFile(domain)).sort((a, b) => a.localeCompare(b));
		},
	};
}

// ═══════════════════════════════════════════════════════════════════
// Module singleton (default file backend) + override hooks
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "pi-lean-host", "secrets");

let _dir = DEFAULT_DIR;
let _store: SecretStore = createFileStore(_dir);

/** Resolve the active store's directory (file backend). */
export function getSecretsDir(): string {
	return _dir;
}

/** Point the file backend at a different directory (test hook). */
export function setSecretsDir(dir: string): void {
	_dir = dir;
	_store = createFileStore(dir);
}

/** Swap in a different store backend (e.g. OS-keychain, deferred). */
export function setStore(store: SecretStore): void {
	_store = store;
}

// Convenience API (delegates to the active store).
export function readSecret(domain: string, name: string): string | null {
	return _store.read(domain, name);
}
export function writeSecret(domain: string, name: string, value: string): void {
	_store.write(domain, name, value);
}
export function deleteSecret(domain: string, name: string): void {
	_store.delete(domain, name);
}
export function deleteDomain(domain: string): void {
	_store.deleteDomain(domain);
}
export function listDomains(): string[] {
	return _store.listDomains();
}
export function listNames(domain: string): string[] {
	return _store.listNames(domain);
}
