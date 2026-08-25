/**
 * Shared HTTP-error classification for the probe and fetch paths.
 *
 * Both api-probe and api-fetch (/api verify) hit the same real-world 403
 * reality: an authenticated-but-forbidden response whose body carries the
 * server's own reason. One classifier keeps the two paths from drifting —
 * probe used to surface the server message while fetch threw a bare status,
 * which made plan-gated 403s read as recipe bugs.
 */

/** Structured "plan not authorized" signal — a 403 whose extracted reason
 *  mentions any of these is a key/subscription limitation, not a recipe bug.
 *  ponytail: keyword match, not a per-API catalog — error-code 1006 is the
 *  motivating case; add provider error-code regexes here if one uses a code
 *  without a matching word. */
const PLAN_GATING = /plan|subscription|tier|not authorized|insufficient|1006/i;

function isObj(data: unknown): data is object {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}

/** Extracts the server's own human-readable reason from an error body — the
 *  note says what the API actually means instead of a synthesized
 *  classification. Returns undefined when the body isn't JSON or carries no
 *  message field; the caller falls back to the bare status.
 *  ponytail: secret-scrub invariant — callers MUST pass the scrubbed body,
 *  never the raw one, or a key echoed in the body would leak into agent
 *  context. */
export function serverMessage(raw: string): string | undefined {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isObj(data)) return undefined;
	const d = data as Record<string, unknown>;
	const status = isObj(d["status"])
		? (d["status"] as Record<string, unknown>)
		: undefined;
	const candidates: unknown[] = [
		d["message"],
		d["error"],
		d["error_message"],
		d["detail"],
		status?.["error_message"],
	];
	const msg = candidates.find(
		(c) => typeof c === "string" && c.trim().length > 0,
	);
	return typeof msg === "string" ? msg.trim().slice(0, 200) : undefined;
}

/** True when the body signals a plan/subscription limitation rather than a
 *  recipe or credential problem. Tests the whole body (not just the
 *  extracted message) so bare error codes like 1006 are caught even when no
 *  message field exists. Callers pass the scrubbed body, per the invariant
 *  on `serverMessage`. */
export function isPlanGated(raw: string): boolean {
	return PLAN_GATING.test(raw);
}
