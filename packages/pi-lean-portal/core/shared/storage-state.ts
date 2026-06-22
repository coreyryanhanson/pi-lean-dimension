/**
 * Storage State Persistence — profile-based save/restore for cookies,
 * localStorage, and IndexedDB.
 *
 * Profiles are stored at ~/.pi/agent/browser-state/<profile>/storage-state.json
 * with version headers for forward compatibility.
 *
 * @module
 */

import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
	unlinkSync,
	rmSync,
	readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── Constants ────────────────────────────────────────────────────────

/** Root directory for all browser profiles. */
export const PROFILE_DIR = join(homedir(), ".pi", "agent", "browser-state");

/** Current storage state version. Increment on breaking format changes. */
const STORAGE_STATE_VERSION = 1;

/** Default size limit (10 MB) before a warning is logged on save. */
const DEFAULT_MAX_STORAGE_STATE_SIZE = 10 * 1024 * 1024;

/** Profile name validation regex. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Reserved keywords that cannot be used as profile names. */
const RESERVED_PROFILE_NAMES = new Set([
	"none",
	"session", // profile modes
	"create",
	"list",
	"clear",
	"clear-all",
	"prune", // subcommands
]);

/** Prefix for auto-generated session-scoped profiles. */
const SESSION_PROFILE_PREFIX = "_session-";

/** Directory where pi stores active session tracking files. */
export const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

// ─── Types ────────────────────────────────────────────────────────────

/** A single cookie as stored by Playwright's storageState. */
interface StoredCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "Strict" | "Lax" | "None";
}

/** A localStorage entry for a given origin. */
interface StoredLocalStorageEntry {
	name: string;
	value: string;
}

/** An origin with its localStorage data. */
interface StoredOrigin {
	origin: string;
	localStorage: StoredLocalStorageEntry[];
}

/**
 * The on-disk format for a storage state file.
 *
 * The `_piVersion` and `_savedAt` fields are added by this module;
 * `cookies` and `origins` match Playwright's storageState output.
 */
export interface StorageStateFile {
	_piVersion: number;
	_savedAt: string;
	_playwrightVersion?: string;
	cookies: StoredCookie[];
	origins: StoredOrigin[];
}

// ─── Profile Name Validation ──────────────────────────────────────────

/**
 * Validate a profile name.
 *
 * Rules:
 * - Must be 1-64 characters long
 * - Only alphanumeric, hyphens, and underscores allowed
 * - Must not be a reserved keyword ("none", "session", "create", "list", "clear", "clear-all", "prune")
 * - Session-scoped names (`_session-*`) are allowed with embedded ID validation
 *
 * @throws {Error} If the name is invalid.
 * @returns The sanitized name (same as input on success).
 */
export function sanitizeProfileName(name: string): string {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("Profile name must be a non-empty string");
	}

	// Session profiles: validate the embedded session ID, then bypass regex
	if (name.startsWith(SESSION_PROFILE_PREFIX)) {
		const sessionId = name.slice(SESSION_PROFILE_PREFIX.length);
		if (!sessionId || /[/\\..\s]/.test(sessionId)) {
			throw new Error(
				`Invalid session profile name '${name}': embedded session ID must be non-empty ` +
					"and must not contain path traversal characters.",
			);
		}
		return name; // Bypass normal regex
	}

	if (!PROFILE_NAME_RE.test(name)) {
		throw new Error(
			`Invalid profile name '${name}'. ` +
				"Profile names must be 1-64 characters, alphanumeric, hyphens, and underscores only.",
		);
	}

	if (RESERVED_PROFILE_NAMES.has(name)) {
		throw new Error(
			`'${name}' is a reserved session mode and cannot be used as a profile name.`,
		);
	}

	return name;
}

// ─── Path Helpers ─────────────────────────────────────────────────────

/**
 * Get the filesystem path to a profile directory.
 * Profile names are sanitized before path construction.
 */
export function profileDir(profileName: string): string {
	const safe = sanitizeProfileName(profileName);
	return join(PROFILE_DIR, safe);
}

/**
 * Get the filesystem path to a profile's storage state file.
 */
export function profileFilePath(profileName: string): string {
	return join(profileDir(profileName), "storage-state.json");
}

// ─── Read / Write ─────────────────────────────────────────────────────

/**
 * Load storage state for a named profile.
 *
 * Returns `null` if no state file exists (first use).
 * Logs a warning if the version is higher than the current code understands.
 *
 * @param profileName - The profile name.
 * @param maxSizeBytes - Optional size limit for warning (default: 10 MB).
 * @returns The parsed storage state, or null if no file exists.
 */
export function loadStorageState(
	profileName: string,
	_maxSizeBytes: number = DEFAULT_MAX_STORAGE_STATE_SIZE,
): StorageStateFile | null {
	const path = profileFilePath(profileName);

	if (!existsSync(path)) {
		return null;
	}

	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as StorageStateFile;

		// Version check — warn on newer versions
		if (
			typeof parsed._piVersion === "number" &&
			parsed._piVersion > STORAGE_STATE_VERSION
		) {
			console.warn(
				`[pi-browser] Storage state for profile '${profileName}' ` +
					`has version ${parsed._piVersion}, but this extension ` +
					`understands version ${STORAGE_STATE_VERSION}. ` +
					"New fields may be ignored.",
			);
		}

		return parsed;
	} catch (err) {
		console.warn(
			`[pi-browser] Failed to load storage state for profile ` +
				`'${profileName}': ${err instanceof Error ? err.message : String(err)}. ` +
				"Starting with fresh state.",
		);
		return null;
	}
}

// ─── Private Helpers ──────────────────────────────────────────────────

/** Temp file prefix for atomic writes. */
const TEMP_FILE_PREFIX = ".storage-state.";
const TEMP_FILE_SUFFIX = ".tmp";

/** ReDoS-safe suffix char: hex digit. */
function tmpSuffix(): string {
	return randomBytes(6).toString("hex");
}

/**
 * Read + parse the storage state file at a given path, or null if
 * missing or invalid.  Unlike `loadStorageState`, this raw variant
 * does NOT log version warnings — it's intended for the merge-read
 * inside `saveStorageState`, where spurious warnings on every save
 * would be noise.
 */
function loadStorageStateRaw(path: string): StorageStateFile | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as StorageStateFile;
	} catch {
		return null;
	}
}

/**
 * Best-effort sweep of orphaned temp files in a profile directory.
 * These can accumulate if a process crashes between write and rename.
 * Failures are silently ignored.
 */
function sweepOrphanedTempFiles(dir: string): void {
	try {
		if (!existsSync(dir)) return;
		const entries = readdirSync(dir);
		for (const entry of entries) {
			if (
				entry.startsWith(TEMP_FILE_PREFIX) &&
				entry.endsWith(TEMP_FILE_SUFFIX)
			) {
				try {
					unlinkSync(join(dir, entry));
				} catch {
					/* best-effort */
				}
			}
		}
	} catch {
		/* best-effort */
	}
}

/**
 * Write `serialized` to `path` atomically: write to a sibling temp file,
 * then rename over the target.  On POSIX, rename is atomic on the same
 * filesystem, so a concurrent reader sees either the old or the new file,
 * never a partial write.
 *
 * The temp file lives in the same directory (guaranteed same filesystem)
 * with a short random suffix to avoid collisions between concurrent
 * writers.  Best-effort cleanup of the temp file on rename failure.
 *
 * File mode is 0600.  The directory is assumed to already exist
 * (callers create it with mode 0700).
 */
function atomicWriteFileSync(path: string, serialized: string): void {
	const dir = dirname(path);
	const tmp = join(dir, `${TEMP_FILE_PREFIX}${tmpSuffix()}${TEMP_FILE_SUFFIX}`);
	try {
		writeFileSync(tmp, serialized, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {
			/* best-effort */
		}
		throw err;
	}
}

/** Composite key identifying a unique cookie slot by name+domain+path. */
function cookieKey(c: { name: string; domain: string; path: string }): string {
	return `${c.name}|${c.domain}|${c.path}`;
}

/**
 * Merge two cookie arrays by `name+domain+path`, last-writer-wins.
 * `incoming` (the just-captured in-memory state) overrides `existing`
 * (the current on-disk state) on collision.
 */
function mergeCookies(
	existing: StoredCookie[],
	incoming: StoredCookie[],
): StoredCookie[] {
	const map = new Map<string, StoredCookie>();
	for (const c of existing) map.set(cookieKey(c), c);
	for (const c of incoming) map.set(cookieKey(c), c); // incoming wins
	return [...map.values()];
}

/**
 * Merge two origins arrays by `origin`, unioning localStorage by `name`
 * (incoming wins on collision).  Origins only in `existing` are preserved;
 * origins only in `incoming` are added.
 */
function mergeOrigins(
	existing: StoredOrigin[],
	incoming: StoredOrigin[],
): StoredOrigin[] {
	const byOrigin = new Map<string, StoredOrigin>();

	// Seed with existing, normalising localStorage into a keyed map
	for (const o of existing) {
		byOrigin.set(o.origin, {
			origin: o.origin,
			localStorage: [...o.localStorage],
		});
	}
	// Merge incoming over existing
	for (const inc of incoming) {
		const cur = byOrigin.get(inc.origin);
		if (!cur) {
			byOrigin.set(inc.origin, {
				origin: inc.origin,
				localStorage: [...inc.localStorage],
			});
			continue;
		}
		const lsMap = new Map<string, StoredLocalStorageEntry>();
		for (const e of cur.localStorage) lsMap.set(e.name, e);
		for (const e of inc.localStorage) lsMap.set(e.name, e); // incoming wins
		cur.localStorage = [...lsMap.values()];
	}
	return [...byOrigin.values()];
}

/**
 * Save storage state for a named profile.
 *
 * Uses cookie-level merge (union by `name+domain+path`) and atomic
 * writes (temp file + rename) to prevent two failure modes under
 * concurrent use of a shared named profile:
 *
 * 1. **Half-write race**: a concurrent reader never sees a partial file.
 * 2. **Wholesale-replace clobber**: non-overlapping cookies set by
 *    concurrent writers are preserved via merge, not erased.
 *
 * Creates the profile directory with 0700 permissions if needed.
 * Logs a warning if the state exceeds `maxSizeBytes` but saves anyway.
 *
 * @param profileName - The profile name.
 * @param state - The raw state object from Playwright's context.storageState().
 *                Must be `{ cookies: [...], origins: [...] }`.
 * @param maxSizeBytes - Optional size limit for warning (default: 10 MB).
 * @returns true if save succeeded, false on failure (logged via console.warn).
 */
export function saveStorageState(
	profileName: string,
	state: { cookies: unknown[]; origins: unknown[] },
	maxSizeBytes: number = DEFAULT_MAX_STORAGE_STATE_SIZE,
): boolean {
	const dir = profileDir(profileName);
	const path = profileFilePath(profileName);

	try {
		// Create profile directory with restricted permissions
		mkdirSync(dir, { recursive: true, mode: 0o700 });

		// Best-effort sweep of orphaned temp files from prior crashes
		sweepOrphanedTempFiles(dir);

		// Read current on-disk state for merge (null = missing/corrupt)
		const diskState = loadStorageStateRaw(path);

		// Merge: union by cookie key (name+domain+path) and origin+name,
		// incoming wins on collision, non-overlapping entries preserved
		const payload: StorageStateFile = {
			_piVersion: STORAGE_STATE_VERSION,
			_savedAt: new Date().toISOString(),
			cookies: mergeCookies(
				diskState?.cookies ?? [],
				state.cookies as StoredCookie[],
			),
			origins: mergeOrigins(
				diskState?.origins ?? [],
				state.origins as StoredOrigin[],
			),
		};

		const serialized = JSON.stringify(payload, null, 2);
		const byteSize = Buffer.byteLength(serialized, "utf-8");

		// Size warning (best-effort, don't block save)
		if (byteSize > maxSizeBytes) {
			const mb = (byteSize / (1024 * 1024)).toFixed(1);
			console.warn(
				`[pi-browser] Storage state for profile '${profileName}' ` +
					`is ${mb} MB — large states may impact startup/save latency. ` +
					`Set browser.maxStorageStateSize to adjust the threshold.`,
			);
		}

		// Atomic write: temp file + rename (atomic on POSIX)
		atomicWriteFileSync(path, serialized);

		return true;
	} catch (err) {
		console.warn(
			`[pi-browser] Failed to save storage state for profile ` +
				`'${profileName}': ${err instanceof Error ? err.message : String(err)}. ` +
				"Session state will be lost.",
		);
		return false;
	}
}

/**
 * Delete the storage state file for a named profile.
 *
 * Also removes the profile directory if it becomes empty (no leftover state
 * files or other artifacts). Does NOT throw — failures are logged and
 * silently ignored.
 *
 * @param profileName - The profile name.
 */
export function deleteStorageState(profileName: string): void {
	const path = profileFilePath(profileName);
	try {
		if (existsSync(path)) {
			unlinkSync(path);
		}
		// Clean up the profile directory if it's now empty
		const dir = profileDir(profileName);
		if (existsSync(dir)) {
			const remaining = readdirSync(dir);
			if (remaining.length === 0) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	} catch (err) {
		console.warn(
			`[pi-browser] Failed to delete storage state for profile ` +
				`'${profileName}': ${err instanceof Error ? err.message : String(err)}.`,
		);
	}
}

// ─── Session Profile Helpers ───────────────────────────────────────

/**
 * Check whether a profile name follows the session-scoped naming convention.
 *
 * Session profiles start with `SESSION_PROFILE_PREFIX` (`_session-`) and
 * encode the pi session ID. They are auto-created for `profile="session"`
 * and cleaned up when the pi session ends.
 *
 * @param name - The profile name to check.
 * @returns `true` if the name starts with `_session-`.
 */
export function isSessionProfile(name: string): boolean {
	return name.startsWith(SESSION_PROFILE_PREFIX);
}

/**
 * Generate a session-scoped profile name from a pi session ID.
 *
 * The returned name follows the `_session-<piSessionId>` convention and
 * can be used with `loadStorageState`/`saveStorageState`.
 *
 * @param piSessionId - The pi session ID (must be non-empty, no path chars).
 * @returns The session-scoped profile name.
 * @throws {Error} If the piSessionId is empty or contains path traversal characters.
 */
export function sessionProfileName(piSessionId: string): string {
	if (!piSessionId || /[/\\..]/.test(piSessionId)) {
		throw new Error(
			`Invalid piSessionId for session profile: '${piSessionId}'`,
		);
	}
	return `${SESSION_PROFILE_PREFIX}${piSessionId}`;
}

/**
 * Check whether a session-scoped profile's backing pi session still exists.
 *
 * Pi writes a session tracking file at `SESSIONS_DIR/<sessionId>.json` for
 * each active conversation. This function checks for that file. If the file
 * is missing, the session has ended and the profile state is stale.
 *
 * Non-session profiles always return `false` (not stale by this metric).
 *
 * @param profileName - The profile name to check.
 * @returns `true` if the profile is session-scoped and its session file is missing.
 */
export function isSessionStale(profileName: string): boolean {
	if (!isSessionProfile(profileName)) return false;
	const sessionId = profileName.slice(SESSION_PROFILE_PREFIX.length);
	const sessionFile = join(SESSIONS_DIR, `${sessionId}.json`);
	return !existsSync(sessionFile);
}

/**
 * Scan the profile directory and remove state for stale session profiles.
 *
 * A session profile is stale when its backing pi session tracking file
 * no longer exists at `SESSIONS_DIR/<sessionId>.json`. This can happen
 * when a conversation ends, is deleted, or the session system is reset.
 *
 * Named profiles (non-`_session-*`) are never touched.
 *
 * @returns An object with `pruned` (removed profile names) and `kept` (active session profile names).
 */
export function pruneStaleSessionProfiles(): {
	pruned: string[];
	kept: string[];
} {
	const result = { pruned: [] as string[], kept: [] as string[] };

	if (!existsSync(PROFILE_DIR)) return result;

	let entries: string[];
	try {
		entries = readdirSync(PROFILE_DIR);
	} catch {
		return result; // Can't read directory — best-effort
	}

	for (const entry of entries) {
		if (!isSessionProfile(entry)) continue;

		try {
			if (isSessionStale(entry)) {
				const fullPath = join(PROFILE_DIR, entry);
				rmSync(fullPath, { recursive: true, force: true });
				result.pruned.push(entry);
			} else {
				result.kept.push(entry);
			}
		} catch {
			// Best-effort — skip problematic entries
		}
	}

	return result;
}
