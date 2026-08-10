/**
 * Response Disk Spill — full JSON spilled to disk when api-fetch truncates.
 *
 * Mirrors portal's snapshot-cache.ts and fetch-backend.ts patterns:
 * - Pure utility functions, no class
 * - Writes only when truncation occurred (json > INLINE_LIMIT)
 * - Graceful I/O degradation (try-catch, returns null on error)
 * - Max 8 files per conversation session (oldest evicted)
 *
 * @module response-spill
 */

import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────

/** Max cached spill files per session (conversation). */
// ponytail: cap; raise if agent reads >8 distinct ops concurrently
const MAX_FILES_PER_SESSION = 8;

/**
 * Spill-file char count above which a size warning is shown.
 * 100k chars ≈ a few hundred KB of pretty-printed JSON.
 */
// ponytail: threshold; tune if agents routinely pull large legit responses
const LARGE_SPILL_THRESHOLD = 100_000;

// ─── Types ──────────────────────────────────────────────────────────────

/** Result of a spill attempt (null = not spilled for any reason). */
export interface SpillResult {
	/** Absolute path to the spilled JSON file. */
	path: string;
}

/** Internal tracking entry. */
interface SpillEntry {
	path: string;
	timestamp: number;
}

// ─── Internal state ────────────────────────────────────────────────────

const activeFiles = new Map<string, SpillEntry[]>();
let _indexCounter = 0;

// ─── Helpers ────────────────────────────────────────────────────────────

function getHostTempDir(): string {
	return process.env.PI_HOST_TEMP_DIR ?? `${tmpdir()}/pi-lean-host`;
}

function ensureHostTempDir(): void {
	try {
		mkdirSync(getHostTempDir(), { recursive: true });
	} catch {
		/* best-effort */
	}
}

function sha256Prefix(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** Sanitize a session key for use in filenames. */
function safeSessionKey(s: string): string {
	return s.replace(/[^a-zA-Z0-9-]/g, "_");
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Spill a full JSON response to a temp file.
 *
 * Writes only when `json` is longer than 4000 chars (truncation will
 * occur). Gracefully degrades to a no-op on any filesystem error.
 * Evicts the oldest file per session when the count exceeds
 * MAX_FILES_PER_SESSION.
 *
 * @param json - The full JSON string to spill
 * @param sessionKey - Conversation-scoped key (e.g. pi session ID)
 * @returns A SpillResult with path, or null if not spilled
 */
export function spillResponse(
	json: string,
	sessionKey: string,
): SpillResult | null {
	if (json.length <= 4000) {
		return null;
	}

	try {
		ensureHostTempDir();

		const digest = sha256Prefix(json);
		const entries = activeFiles.get(sessionKey) ?? [];
		const index = _indexCounter++;
		const safe = safeSessionKey(sessionKey);
		const filePath = join(
			getHostTempDir(),
			`response-${safe}-${digest}-${index}.json`,
		);

		writeFileSync(filePath, json, "utf-8");

		const newEntry: SpillEntry = { path: filePath, timestamp: Date.now() };
		entries.push(newEntry);
		activeFiles.set(sessionKey, entries);

		// Evict oldest if over limit
		if (entries.length > MAX_FILES_PER_SESSION) {
			entries.sort((a, b) => a.timestamp - b.timestamp);
			const toRemove = entries.splice(
				0,
				entries.length - MAX_FILES_PER_SESSION,
			);
			for (const entry of toRemove) {
				try {
					rmSync(entry.path, { force: true });
				} catch {
					/* best-effort */
				}
			}
		}

		return { path: filePath };
	} catch {
		// Graceful degradation: any I/O error → no spill
		return null;
	}
}

/**
 * Remove ALL spilled files tracked by this process across all sessions.
 * Called during session_shutdown.
 *
 * Only files this process created (tracked in `activeFiles`) are removed —
 * the shared temp dir is left in place so a concurrent pi session's spill
 * files aren't deleted out from under it.
 */
export function cleanupAllSpill(): void {
	for (const [, entries] of activeFiles) {
		for (const entry of entries) {
			try {
				rmSync(entry.path, { force: true });
			} catch {
				/* best-effort */
			}
		}
	}
	activeFiles.clear();
}

/**
 * Build a hint string for the truncated-response spill notice.
 *
 * Returns a line pointing at the spill file when a result exists,
 * or a graceful-degradation fallback when it doesn't.
 */
export function formatSpillNotice(
	spill: SpillResult | null,
	jsonLength: number,
): string {
	if (!spill) {
		return (
			`\n_Response truncated at 4000 chars. Full response has ${jsonLength} chars ` +
			`(disk spill unavailable — re-call api-fetch to regenerate)._`
		);
	}
	const lines: string[] = [];
	if (jsonLength > LARGE_SPILL_THRESHOLD) {
		lines.push(
			`⚠ Very large response — narrow your query params to reduce the result size.`,
		);
	}
	lines.push(
		`📄 Full response (${jsonLength} chars) written to ${spill.path}. ` +
			`Search it with grep for the field you need (e.g. \`grep -o '"<field>":[^,]*' ${spill.path}\`), ` +
			`or page through it with read + offset/limit — before calling api-fetch again, the data may already be here.`,
	);
	return lines.join("\n");
}
