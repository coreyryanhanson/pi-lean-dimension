/**
 * Snapshot Disk Cache — Phase 1 of the browser-intelligence plan.
 *
 * When compactSnapshot() truncates a page's accessibility tree, the full
 * tree is written to /tmp/pi-browser/snapshot-*.txt so the agent can read
 * elements past the truncation boundary with the read tool.
 *
 * Design parallels capFetchContent() in fetch-backend.ts:
 * - Pure utility functions, no class or global state beyond a tracking Map
 * - Caches ONLY when truncation occurred (snapshot > 2800 chars)
 * - Never caches bot-detected snapshots
 * - Graceful I/O degradation (try-catch, no crash on disk errors)
 * - Max 2 files per task (oldest evicted)
 *
 * @module snapshot-cache
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

// ─── Constants ──────────────────────────────────────────────────────────

/** Only cache when the snapshot exceeds this threshold (same as router.ts's COMPACT_SNAPSHOT_NO_TRUNCATE). */
const CACHE_TRUNCATE_THRESHOLD = 2800;

/** Maximum cached snapshot files per task. */
const MAX_FILES_PER_TASK = 2;

/** Temp file directory for snapshot caches. */
const SNAPSHOT_CACHE_DIR = `${tmpdir()}/pi-browser`;

// ─── Types ──────────────────────────────────────────────────────────────

/** Result of a cache attempt (null = not cached for any reason). */
export interface CacheResult {
	/** Absolute path to the cached snapshot file. */
	path: string;
	/** Snapshot fingerprint (for staleness detection in Phase 2). */
	fingerprint: string;
}

/** Internal tracking entry for a cached file. */
interface CacheEntry {
	path: string;
	fingerprint: string;
	timestamp: number;
}

// ─── Internal state ────────────────────────────────────────────────────

/**
 * Tracks active snapshot temp files per task.
 * For each task, entries are kept in insertion order (oldest first).
 */
const activeSnapshotFiles = new Map<string, CacheEntry[]>();

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute an 8-char hex fingerprint of a string.
 */
function sha256Prefix(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Sanitize a taskId for use in filenames.
 */
function safeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9-]/g, "_");
}

/**
 * Build a snapshot cache file path.
 */
function buildCacheFilePath(
	taskId: string,
	digest: string,
	index: number,
): string {
	const tid = safeTaskId(taskId);
	return `${SNAPSHOT_CACHE_DIR}/snapshot-${tid}-${digest}-${index}.txt`;
}

/**
 * Ensure the cache directory exists.
 */
function ensureCacheDir(): void {
	try {
		mkdirSync(SNAPSHOT_CACHE_DIR, { recursive: true });
	} catch {
		// best-effort — writeFileSync will fail below and be caught
	}
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Cache a snapshot's full text to a temp file.
 *
 * Only caches when:
 * 1. The snapshot is longer than CACHE_TRUNCATE_THRESHOLD (truncation occurred)
 * 2. botDetected is falsy (misleading content)
 *
 * Gracefully degrades to a no-op on any filesystem error.
 * Evicts the oldest file per task when the count exceeds MAX_FILES_PER_TASK.
 *
 * @param taskId - The task ID (used for file naming and tracking)
 * @param snapshot - The full snapshot text to cache
 * @param fingerprint - A stable hash/fingerprint for the snapshot
 * @param botDetected - Whether the page triggered bot detection
 * @returns A CacheResult with path and fingerprint, or null if not cached
 */
export function cacheSnapshot(
	taskId: string,
	snapshot: string,
	fingerprint: string,
	botDetected: boolean,
): CacheResult | null {
	// Only cache when truncation occurred
	if (snapshot.length <= CACHE_TRUNCATE_THRESHOLD) {
		return null;
	}

	// Never cache bot-detected pages
	if (botDetected) {
		return null;
	}

	try {
		ensureCacheDir();

		const digest = sha256Prefix(snapshot);
		const existingEntries = activeSnapshotFiles.get(taskId) ?? [];

		// Determine index: next sequential index based on existing files
		const nextIndex = existingEntries.reduce((max, entry) => {
			const match = entry.path.match(/-(\d+)\.txt$/);
			const idx = match ? parseInt(match[1]!, 10) : -1;
			return Math.max(max, idx + 1);
		}, 0);

		const filePath = buildCacheFilePath(taskId, digest, nextIndex);
		writeFileSync(filePath, snapshot, "utf-8");

		// Track the new entry
		const newEntry: CacheEntry = {
			path: filePath,
			fingerprint,
			timestamp: Date.now(),
		};
		existingEntries.push(newEntry);
		activeSnapshotFiles.set(taskId, existingEntries);

		// Evict oldest if over limit
		if (existingEntries.length > MAX_FILES_PER_TASK) {
			// Sort by timestamp (oldest first) and remove the oldest
			existingEntries.sort((a, b) => a.timestamp - b.timestamp);
			const toRemove = existingEntries.splice(
				0,
				existingEntries.length - MAX_FILES_PER_TASK,
			);
			for (const entry of toRemove) {
				try {
					rmSync(entry.path, { force: true });
				} catch {
					/* best-effort */
				}
			}
		}

		return { path: filePath, fingerprint };
	} catch {
		// Graceful degradation: any I/O error → no cache
		return null;
	}
}

/**
 * Remove all cached snapshot files for a specific task.
 *
 * @param taskId - The task ID whose cached files should be removed.
 */
export function removeSnapshotFiles(taskId: string): void {
	const entries = activeSnapshotFiles.get(taskId);
	if (!entries) return;

	for (const entry of entries) {
		try {
			rmSync(entry.path, { force: true });
		} catch {
			/* best-effort */
		}
	}
	activeSnapshotFiles.delete(taskId);
}

/**
 * Remove ALL cached snapshot files across all tasks.
 * Called during session_shutdown.
 */
export function removeAllSnapshotFiles(): void {
	for (const [, entries] of activeSnapshotFiles) {
		for (const entry of entries) {
			try {
				rmSync(entry.path, { force: true });
			} catch {
				/* best-effort */
			}
		}
	}
	activeSnapshotFiles.clear();

	// Also attempt to remove the cache directory itself
	try {
		rmSync(SNAPSHOT_CACHE_DIR, { recursive: true, force: true });
	} catch {
		/* best-effort — dir may not be empty due to other files */
	}
}

/**
 * Build the cache notice line appended to compacted snapshot output.
 *
 * Returns a non-empty string only when a cache file was written AND the
 * snapshot was actually truncated (> CACHE_TRUNCATE_THRESHOLD).
 *
 * @param cacheResult - The result from cacheSnapshot() (null if not cached)
 * @param snapshotLength - The length of the original (uncached) snapshot
 * @param truncated - Whether the snapshot was truncated by compactSnapshot()
 * @returns A cache notice string (empty if no cache should be advertised)
 */
export function formatCacheNotice(
	cacheResult: CacheResult | null,
	snapshotLength: number,
	truncated: boolean,
): string {
	if (cacheResult && truncated && snapshotLength > CACHE_TRUNCATE_THRESHOLD) {
		return `\n📄 Full snapshot cached at ${cacheResult.path}`;
	}
	return "";
}
