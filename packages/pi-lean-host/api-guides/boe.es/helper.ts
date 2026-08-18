/**
 * BOE synthetic helper — pre-call param transform for the `local-helper`
 * axis. Converts ISO dates supplied by the agent into BOE's `aaaammdd`
 * form for the ops that declare `helper: true`.
 *
 * Helper contract:
 *   (params, ctx) => params
 */

/** Convert an ISO date (YYYY-MM-DD) to BOE form (YYYYMMDD); else pass through. */
function toBoeDate(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return value;
	return `${m[1]}${m[2]}${m[3]}`;
}

export default function boeHelper(
	params: Record<string, unknown>,
	_ctx: { operation: string; domain: string },
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...params };
	for (const key of ["fecha", "from", "to"] as const) {
		if (out[key] !== undefined) out[key] = toBoeDate(out[key]);
	}
	return out;
}
