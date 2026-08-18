/**
 * Wikimedia synthetic helper — named post-response `transform` for the
 * `transform-builtin` axis (paginate × tokenBag). Projects each
 * recentchanges entry to a lean field set.
 *
 * Non-lossy: a non-object item passes through untouched.
 */

export function transform(
	item: unknown,
	_ctx: { operation: string; domain: string },
): unknown {
	if (!item || typeof item !== "object") return item;
	const r = item as Record<string, unknown>;
	return {
		pageid: r["pageid"],
		title: r["title"],
		timestamp: r["timestamp"],
		user: r["user"],
		type: r["type"],
	};
}
