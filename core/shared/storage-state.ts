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
	existsSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Constants ────────────────────────────────────────────────────────

/** Root directory for all browser profiles. */
export const PROFILE_DIR = join(homedir(), ".pi", "agent", "browser-state");

/** Current storage state version. Increment on breaking format changes. */
export const STORAGE_STATE_VERSION = 1;

/** Default size limit (10 MB) before a warning is logged on save. */
export const DEFAULT_MAX_STORAGE_STATE_SIZE = 10 * 1024 * 1024;

/** Profile name validation regex. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Reserved keywords that cannot be used as profile names. */
const RESERVED_PROFILE_NAMES = new Set(["new", "last"]);

// ─── Types ────────────────────────────────────────────────────────────

/** A single cookie as stored by Playwright's storageState. */
export interface StoredCookie {
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
export interface StoredLocalStorageEntry {
	name: string;
	value: string;
}

/** An origin with its localStorage data. */
export interface StoredOrigin {
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
 * - Must not be a reserved keyword ("new", "last")
 *
 * @throws {Error} If the name is invalid.
 * @returns The sanitized name (same as input on success).
 */
export function sanitizeProfileName(name: string): string {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("Profile name must be a non-empty string");
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
	maxSizeBytes: number = DEFAULT_MAX_STORAGE_STATE_SIZE,
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

/**
 * Save storage state for a named profile.
 *
 * Writes version headers, creates the profile directory with 0700
 * permissions if needed, and sets file mode 0600.
 *
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

		// Build the file payload with version headers
		const payload: StorageStateFile = {
			_piVersion: STORAGE_STATE_VERSION,
			_savedAt: new Date().toISOString(),
			cookies: state.cookies as StoredCookie[],
			origins: state.origins as StoredOrigin[],
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

		// Write with restricted permissions
		writeFileSync(path, serialized, { mode: 0o600 });

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
 * Does NOT remove the profile directory (may contain other files in future).
 * Does NOT throw — failures are logged and silently ignored.
 *
 * @param profileName - The profile name.
 */
export function deleteStorageState(profileName: string): void {
	const path = profileFilePath(profileName);
	try {
		if (existsSync(path)) {
			unlinkSync(path);
		}
	} catch (err) {
		console.warn(
			`[pi-browser] Failed to delete storage state for profile ` +
				`'${profileName}': ${err instanceof Error ? err.message : String(err)}.`,
		);
	}
}
