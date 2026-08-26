/**
 * OAuth2 token store — per-domain token-set persistence.
 *
 * File backend: `~/.pi/agent/pi-lean-host/oauth/<domain>.json`, one token
 * object per domain. SEPARATE from the secrets store because tokens rotate
 * and have structure (`expiresAt`, `refreshToken`) — raw secrets don't. Two
 * 0600 file stores with the same `SecretStore`-style interface shape is
 * simpler than one overloaded file. `client_secret` stays in the secrets
 * store (a raw credential provisioned once); only minted tokens live here.
 *
 * Security posture mirrors secrets-store.ts: 0600 files, lazy-mkdir on write
 * only, names-only listing. The store is swappable (the `TokenStore`
 * interface + `setTokenStore`) so a deferred OS-keychain backend is a
 * drop-in without touching callers.
 *
 * Kept free of any `auth.ts` import — the edge is one-way (auth.ts → here),
 * so no import cycle can form.
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
import { assertSafeDomain } from "./path-template.js";

/** A minted token set for one domain. */
export interface OAuthToken {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms when the access token expires. Absent → treat as never-expiring. */
	expiresAt?: number;
	scope?: string;
}

/** A token store: read/write/delete one domain's token set. */
export interface TokenStore {
	read(domain: string): OAuthToken | null;
	write(domain: string, token: OAuthToken): void;
	delete(domain: string): void;
	listDomains(): string[];
}

/** File-backed store rooted at `dir` (one `<domain>.json` per domain). */
export function createTokenStore(dir: string): TokenStore {
	const domainPath = (domain: string): string => {
		assertSafeDomain(domain);
		return join(dir, `${domain}.json`);
	};

	const readFile = (domain: string): OAuthToken | null => {
		const p = domainPath(domain);
		if (!existsSync(p)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
			if (
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				typeof (parsed as OAuthToken).accessToken === "string"
			) {
				return parsed as OAuthToken;
			}
			return null;
		} catch {
			return null;
		}
	};

	return {
		read(domain) {
			return readFile(domain);
		},
		write(domain, token) {
			const p = domainPath(domain); // also asserts domain safety
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(p, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 });
			try {
				chmodSync(p, 0o600); // guard against umask overriding the mode
			} catch {
				// best-effort; file was already written
			}
		},
		delete(domain) {
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
	};
}

// ═══════════════════════════════════════════════════════════════════
// Module singleton (default file backend) + override hooks
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "pi-lean-host", "oauth");

let _dir = DEFAULT_DIR;
let _store: TokenStore = createTokenStore(_dir);

/** Resolve the active store's directory (file backend). */
export function getOAuthDir(): string {
	return _dir;
}

/** Point the file backend at a different directory (test hook). */
export function setOAuthDir(dir: string): void {
	_dir = dir;
	_store = createTokenStore(dir);
}

/** Swap in a different store backend (e.g. OS-keychain, deferred). */
export function setTokenStore(store: TokenStore): void {
	_store = store;
}

// Convenience API (delegates to the active store).
export function readToken(domain: string): OAuthToken | null {
	return _store.read(domain);
}
export function writeToken(domain: string, token: OAuthToken): void {
	_store.write(domain, token);
}
export function deleteToken(domain: string): void {
	_store.delete(domain);
}
export function listTokenDomains(): string[] {
	return _store.listDomains();
}
