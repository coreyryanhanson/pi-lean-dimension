/**
 * OAuth2 token store — per-domain, per-slot token persistence.
 *
 * File backend: `~/.pi/agent/pi-lean-host/oauth/<domain>.json`, one file per
 * domain holding `Record<slot, StampedToken>` — the secrets-store's per-domain
 * name-keyed shape, not a filename-as-database layout. The slot key derives
 * from `(grant, tokenUrl)` via `slotKey`: the same domain can
 * hold an app token and a user token (and tokens from two issuers) without
 * clobbering, while multi-recipe domains sharing one grant + issuer keep
 * sharing a slot. `slotKey` takes the two facts structurally — the store
 * layer stays free of `auth.ts` types.
 *
 * SEPARATE from the secrets store because tokens rotate and have structure
 * (`expiresAt`, `refreshToken`) — raw secrets don't. Two 0600 file stores
 * with the same interface shape is simpler than one overloaded file.
 * `client_secret` stays in the secrets store (a raw credential provisioned
 * once); only minted tokens live here.
 *
 * Security posture mirrors secrets-store.ts: 0600 files, lazy-mkdir on write
 * only, names-only listing. The store is swappable (the `TokenStore`
 * interface + `createTokenStore`) so a deferred OS-keychain backend is a
 * drop-in without touching callers.
 *
 * Kept free of any `auth.ts` import — the edge is one-way (auth.ts → here),
 * so no import cycle can form.
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { assertSafeDomain } from "./path-template.js";

/** A minted token set for one (domain, grant, tokenUrl) slot. */
export interface OAuthToken {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms when the access token expires. Absent → treat as never-expiring. */
	expiresAt?: number;
	scope?: string;
}

/** A stored token with its mint facts. The store layer requires the stamp:
 *  every entry must be self-describing, so slot enumeration can render real
 *  grant/issuer and the orphan arms can round-trip a slot's key from its
 *  record (unstamped/legacy records fail validation → ignored, re-minted). */
export type StampedToken = OAuthToken & { grant: string; tokenUrl: string };

/**
 * The token-slot key: `<grant>__<hash(tokenUrl)>`. Two tokens share a slot
 * iff they share store domain + grant + token URL — same domain + same grant
 * + same issuer → same slot (multi-recipe domains keep sharing); any
 * difference → a different slot key in the same file. Hash the FULL URL
 * (never just the path): two issuers behind one API domain can differ by
 * host only (tenant-a vs tenant-b auth0). ≥16 hex chars of SHA-256 so
 * tenant-farm issuers don't collide. TokenUrl *spelling* differences
 * fragment slots rather than clobber — harmless, just expected.
 */
export function slotKey(grant: string, tokenUrl: string): string {
	const hash = createHash("sha256").update(tokenUrl).digest("hex").slice(0, 16);
	return `${grant}__${hash}`;
}

/** One slot's stored token, with the facts status rows render. */
export interface TokenSlotInfo {
	slot: string;
	grant: string;
	tokenUrl: string;
	token: OAuthToken;
}

/** Read a slot map file. Missing/corrupt file → {}; entries failing
 *  `isEntry` are dropped. Shared by the token file and the pending-flow
 *  scratch file — same read-parse-validate loop, one implementation. */
function readJsonMap<T>(
	p: string,
	isEntry: (value: Record<string, unknown>) => boolean,
): Record<string, T> {
	if (!existsSync(p)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const map: Record<string, T> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				isEntry(value)
			) {
				map[key] = value as T;
			}
		}
		return map;
	} catch {
		return {};
	}
}

/** Write a JSON map 0600 atomically: lazy mkdir + tmp file + rename (atomic
 *  on POSIX), so a crash mid-write can't shred the file's existing entries. */
function writeJson0600(p: string, data: unknown): void {
	if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
	try {
		chmodSync(tmp, 0o600); // guard against umask overriding the mode
	} catch {
		// best-effort; rename still proceeds
	}
	renameSync(tmp, p);
}

/**
 * A token store: read/write/delete one (domain, slot) token; enumerate a
 * domain's slots and the store's domains. One `<domain>.json` per domain
 * holding `Record<slot, StampedToken>` — slot enumeration is `Object.keys`
 * of the file (the secrets store's `listNames` pattern), never filename
 * parsing. Writes require the stamp: every entry must carry the grant +
 * tokenUrl it was minted under, so records are self-describing.
 */
export interface TokenStore {
	read(domain: string, slot: string): StampedToken | null;
	write(domain: string, slot: string, token: StampedToken): void;
	delete(domain: string, slot: string): void;
	listSlots(domain: string): TokenSlotInfo[];
	listDomains(): string[];
}

/** File-backed store rooted at `dir` (one `<domain>.json` per domain). */
export function createTokenStore(dir: string): TokenStore {
	const domainPath = (domain: string): string => {
		assertSafeDomain(domain);
		return join(dir, `${domain}.json`);
	};

	// Read a domain file as a slot→token map. Missing/corrupt file → {}.
	// Entries must carry the write() stamp (grant + tokenUrl); anything else —
	// a foreign or hand-edited file — fails the check and reads as empty.
	// Tokens are re-minted, no migration.
	const readFileMap = (domain: string): Record<string, StampedToken> =>
		readJsonMap(
			domainPath(domain),
			(v) =>
				typeof v.accessToken === "string" &&
				typeof v.grant === "string" &&
				typeof v.tokenUrl === "string",
		);

	const toSlotInfo = (slot: string, token: StampedToken): TokenSlotInfo => ({
		slot,
		grant: token.grant,
		tokenUrl: token.tokenUrl,
		token,
	});

	return {
		read(domain, slot) {
			return readFileMap(domain)[slot] ?? null;
		},
		write(domain, slot, token) {
			const map = readFileMap(domain); // sync RMW: atomic wrt the event loop
			map[slot] = token;
			writeJson0600(domainPath(domain), map);
		},
		delete(domain, slot) {
			const map = readFileMap(domain);
			if (!Object.hasOwn(map, slot)) return;
			delete map[slot];
			if (Object.keys(map).length === 0) {
				// Prune the empty file so the domain drops out of listDomains.
				rmSync(domainPath(domain), { force: true });
			} else {
				writeJson0600(domainPath(domain), map);
			}
		},
		listSlots(domain) {
			return Object.entries(readFileMap(domain))
				.map(([slot, token]) => toSlotInfo(slot, token))
				.sort((a, b) => a.slot.localeCompare(b.slot));
		},
		listDomains() {
			if (!existsSync(dir)) return [];
			// Exclude `<domain>.pending.json` — the pending-flow scratch file is
			// not a token domain (a live pending flow must not surface as a
			// bogus "unreadable" row in bare /api oauth).
			return readdirSync(dir)
				.filter((f) => f.endsWith(".json") && !f.endsWith(".pending.json"))
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

// Convenience API (delegates to the active store). Slot derivation is
// INTERNAL to the store layer: callers pass the `grant` + `tokenUrl` facts
// they already carry in their `OAuth2Auth` object — never a precomputed slot.
export function readToken(
	domain: string,
	grant: string,
	tokenUrl: string,
): OAuthToken | null {
	return _store.read(domain, slotKey(grant, tokenUrl));
}
export function writeToken(
	domain: string,
	grant: string,
	tokenUrl: string,
	token: OAuthToken,
): void {
	// Stamp the record so the store is self-describing (status rows render the
	// real issuer instead of the opaque hash).
	_store.write(domain, slotKey(grant, tokenUrl), { ...token, grant, tokenUrl });
}
export function deleteToken(
	domain: string,
	grant: string,
	tokenUrl: string,
): void {
	_store.delete(domain, slotKey(grant, tokenUrl));
}
export function listSlots(domain: string): TokenSlotInfo[] {
	return _store.listSlots(domain);
}
export function listTokenDomains(): string[] {
	return _store.listDomains();
}

// ═══════════════════════════════════════════════════════════════════
// Pending auth-code flow (manual-code handoff)
// ═══════════════════════════════════════════════════════════════════

/**
 * A pending authorization-code flow — the PKCE verifier + state + redirect_uri
 * generated at the authorize step, persisted so the later paste/`--code`
 * completion step can exchange with the SAME verifier (the code exchange
 * fails if the verifier doesn't match the challenge sent in the authorize
 * URL) and validate the pasted `state`. Written by the authorize step,
 * consumed once at completion. Ephemeral scratch — lives on the file dir
 * even if a keychain token backend is swapped in. Stored as
 * `Record<slot, PendingAuthCodeFlow>` in `<domain>.pending.json` (slot-keyed
 * like the token file; only `authorization_code` ever writes entries, so a
 * pending slot is always an auth-code slot). Kept OUTSIDE the `TokenStore`
 * interface on purpose — a keychain backend swap must not carry it.
 */
export interface PendingAuthCodeFlow {
	verifier: string;
	state: string;
	/** The redirect URI sent in the authorize request — the token exchange
	 *  must send the SAME URI (RFC 6749 §4.1.3). Defaulted to REDIRECT_URI
	 *  by the flow; user-overridable per invocation (e.g. Twitch requires
	 *  https or the `localhost` spelling). Read back on `--code` completion. */
	redirectUri: string;
}

function pendingPath(domain: string): string {
	assertSafeDomain(domain);
	return join(_dir, `${domain}.pending.json`);
}

function readPendingMap(domain: string): Record<string, PendingAuthCodeFlow> {
	return readJsonMap(
		pendingPath(domain),
		(v) => typeof v.verifier === "string" && typeof v.redirectUri === "string",
	);
}

export function writePendingFlow(
	domain: string,
	grant: string,
	tokenUrl: string,
	flow: PendingAuthCodeFlow,
): void {
	const map = readPendingMap(domain);
	map[slotKey(grant, tokenUrl)] = flow;
	writeJson0600(pendingPath(domain), map);
}

export function readPendingFlow(
	domain: string,
	grant: string,
	tokenUrl: string,
): PendingAuthCodeFlow | null {
	return readPendingMap(domain)[slotKey(grant, tokenUrl)] ?? null;
}

export function deletePendingFlow(
	domain: string,
	grant: string,
	tokenUrl: string,
): void {
	const p = pendingPath(domain);
	if (!existsSync(p)) return;
	const map = readPendingMap(domain);
	const slot = slotKey(grant, tokenUrl);
	if (!Object.hasOwn(map, slot)) return;
	delete map[slot];
	if (Object.keys(map).length === 0) {
		rmSync(p, { force: true });
	} else {
		writeJson0600(p, map);
	}
}
