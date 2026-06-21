/**
 * Task ID Resolution — maps pi session IDs to stable "browser-N" keys.
 *
 * Previously lived in `tools/utils.ts`, which made the logic inaccessible
 * to `core/` modules and command handlers. Moved here so all layers can
 * share the same session-to-task mapping.
 *
 * Invariant: the return value is always filename-safe (matches
 * /^[a-zA-Z0-9-]+$/). Callers do not need to apply `safeTaskId()`
 * from `paths.js` to the output of this function.
 *
 * @module task-id
 */

// ─── Internal state ──────────────────────────────────────────────

/** Maps pi session IDs to stable "browser-N" keys. */
const _sessionKeys = new Map<string, string>();

/** Monotonic counter for generating browser-N keys. */
let _sessionCounter = 0;

// ─── Public API ──────────────────────────────────────────────────

/**
 * Get a stable taskId for the current tool call context.
 *
 * Maps pi session IDs to monotonic "browser-N" keys so that all
 * tool calls within the same pi conversation share the same browser
 * session.
 *
 * - When a piSessionId is available, returns `browser-1`, `browser-2`, etc.
 * - When no piSessionId is available, returns `"browser-default"`.
 *
 * @param ctx - An object that may contain a `sessionManager` with a
 *              `getSessionId()` method (e.g. the `ctx` argument from
 *              a pi tool's `execute` callback, or an `ExtensionContext`).
 * @returns A stable, filename-safe task ID string.
 */
export function taskId(ctx: {
	sessionManager?: { getSessionId?(): string };
}): string {
	const piSessionId = ctx?.sessionManager?.getSessionId?.();
	if (piSessionId) {
		if (!_sessionKeys.has(piSessionId)) {
			_sessionKeys.set(piSessionId, `browser-${++_sessionCounter}`);
		}
		return _sessionKeys.get(piSessionId)!;
	}
	return "browser-default";
}

/**
 * Remove a pi session ID from the internal mapping.
 *
 * Called during `session_shutdown` so that the ID-to-key mapping
 * doesn't leak across conversations. Does nothing if the session
 * ID is not found.
 *
 * @param piSessionId - The pi session ID to remove.
 */
export function deleteSessionKey(piSessionId: string): void {
	_sessionKeys.delete(piSessionId);
}

/**
 * Reset all internal task-ID state.
 *
 * Clears the piSessionId-to-key mapping and resets the monotonic counter.
 * Called at the start of the extension entry function to ensure safe
 * re-invocation when pi reuses the cached module factory (e.g.
 * during /resume to the same working directory).
 */
export function resetTaskIds(): void {
	_sessionKeys.clear();
	_sessionCounter = 0;
}
