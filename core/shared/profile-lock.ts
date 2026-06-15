/**
 * Advisory Profile Lock — prevents concurrent writes to the same profile
 * from parallel sessions.
 *
 * Uses `mkdirSync` as the atomic creation primitive.  POSIX guarantees
 * `mkdir` is atomic on local filesystems — it either succeeds as the sole
 * creator, or fails if the directory already exists.  This avoids the
 * check-then-act race condition of file-based locks.
 *
 * Lock files contain a metadata JSON file with PID, taskId, and timestamp
 * for diagnostics and staleness detection.
 *
 * @module
 */

import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";

// ─── Constants ────────────────────────────────────────────────────────

/** Name of the lock metadata file inside the lock directory. */
const LOCK_INFO_FILE = "info.json";

/**
 * How old a lock can be before we steal it (1 hour).
 * This handles cross-container scenarios where PID checks are unreliable.
 */
const STALE_LOCK_MS = 60 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────

/** Metadata written inside the lock directory. */
interface LockInfo {
	pid: number;
	taskId: string;
	acquiredAt: number; // Date.now()
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Get the path to the lock directory for a profile directory.
 */
function lockDir(profileDir: string): string {
	return join(profileDir, ".lock");
}

/**
 * Check whether a process is currently alive.
 *
 * Uses `process.kill(pid, 0)` (signal 0 = existence check).
 * Works for same-machine, same-user processes. In cross-container
 * environments the timestamp-based staleness check is the fallback.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the lock info file from a lock directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readLockInfo(ld: string): LockInfo | null {
	try {
		const infoPath = join(ld, LOCK_INFO_FILE);
		if (!existsSync(infoPath)) return null;
		const raw = readFileSync(infoPath, "utf-8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

/**
 * Write the lock info file into a lock directory.
 */
function writeLockInfo(ld: string, info: LockInfo): void {
	writeFileSync(join(ld, LOCK_INFO_FILE), JSON.stringify(info), {
		mode: 0o600,
	});
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Attempt to acquire an advisory lock on a profile directory.
 *
 * Uses `mkdirSync` as the atomic creation primitive — POSIX guarantees
 * `mkdir` either succeeds as the sole creator, or fails if the directory
 * exists. This avoids the check-then-act race condition of file-based locks.
 *
 * Stale locks (process dead or older than `STALE_LOCK_MS`) are stolen
 * automatically.
 *
 * @param profileDir - Absolute path to the profile directory.
 * @param taskId     - The task attempting to acquire the lock.
 * @returns `true` if the lock was acquired, `false` if held by another
 *          active session.
 */
export function acquireProfileLock(
	profileDir: string,
	taskId: string,
): boolean {
	// Ensure the profile directory exists
	mkdirSync(profileDir, { recursive: true });

	const ld = lockDir(profileDir);

	// Try atomic mkdir
	try {
		mkdirSync(ld);
		// We got it — write metadata for diagnostics
		const info: LockInfo = { pid: process.pid, taskId, acquiredAt: Date.now() };
		writeLockInfo(ld, info);
		return true;
	} catch {
		// Directory exists — check if the lock is stale
	}

	// Lock exists — read metadata and check staleness
	try {
		const existing = readLockInfo(ld);
		if (!existing) {
			// No metadata — steal the lock
			// (directory exists but no info file; likely from a crash
			//  during lock acquisition)
			const info: LockInfo = {
				pid: process.pid,
				taskId,
				acquiredAt: Date.now(),
			};
			writeLockInfo(ld, info);
			return true;
		}

		// Same task — re-acquisition (e.g. after crash recovery)
		if (existing.taskId === taskId) {
			const info: LockInfo = {
				pid: process.pid,
				taskId,
				acquiredAt: Date.now(),
			};
			writeLockInfo(ld, info);
			return true;
		}

		// Different task — check if the holder is still alive
		const age = Date.now() - existing.acquiredAt;
		const alive = isProcessAlive(existing.pid);

		if (!alive || age > STALE_LOCK_MS) {
			// Stale lock — steal it
			const info: LockInfo = {
				pid: process.pid,
				taskId,
				acquiredAt: Date.now(),
			};
			writeLockInfo(ld, info);
			return true;
		}

		// Lock is held by an active session — fail
		return false;
	} catch {
		// Can't read or write metadata — conservatively assume lock is held
		return false;
	}
}

/**
 * Release an advisory lock on a profile directory.
 *
 * Only releases if the lock belongs to the given `taskId`.
 * Best-effort — failures are silently ignored.
 */
export function releaseProfileLock(profileDir: string, taskId: string): void {
	const ld = lockDir(profileDir);
	try {
		const existing = readLockInfo(ld);
		if (existing && existing.taskId === taskId) {
			rmSync(ld, { recursive: true, force: true });
		}
	} catch {
		// Best-effort
	}
}
