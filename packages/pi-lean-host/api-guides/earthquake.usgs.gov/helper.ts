/**
 * earthquake.usgs.gov post-response transform — reshapes a GeoJSON `Feature`
 * and projects its fat `properties` bag down to a lean, agent-ready set.
 *
 * Handles both hookpoint shapes (the transform is gated on the summary feeds
 * and `queryEvents`):
 *  - restGet (whole-body, the 20 summary feeds): `data` is a
 *    `FeatureCollection` → returns the same envelope with each `features[]`
 *    item transformed.
 *  - paginate (per-item, `queryEvents`): `data` is a single `Feature` →
 *    returns the transformed feature.
 *
 * Per feature it:
 *  1. **Reshapes** the positional `geometry.coordinates: [lon, lat, depth]`
 *     (the G7 stress) into flat scalar `lon` / `lat` / `depth` fields.
 *  2. **Projects** `properties` to the fields an agent most needs, dropping
 *     the noise (updated, tz, felt, cdi, mmi, alert, sig, net, code, ids,
 *     sources, types, nst, dmin, rms, gap, detail, …) that bloats context.
 *
 * Transform contract: (data, ctx) => unknown. Declared via `transform: true`
 * in guide.md. Loaded by `loadTransform`, invoked by the restGet / paginate
 * hookpoints; a throw falls back to the raw body / item with a warning
 * (graceful, no disable). Pure function — no default export.
 */

/** Fields from `feature.properties` the agent actually reads. */
const PROPERTY_KEEP = [
	"mag",
	"place",
	"time",
	"url",
	"status",
	"tsunami",
	"magType",
	"type",
	"title",
] as const;

interface GeoJsonFeature {
	id?: unknown;
	geometry?: { coordinates?: unknown };
	properties?: Record<string, unknown>;
}

function projectFeature(feature: unknown): unknown {
	if (!feature || typeof feature !== "object") return feature;
	const f = feature as GeoJsonFeature;
	// Only project things that actually look like a GeoJSON Feature — anything
	// else passes through untouched (same shape-guard the CDX / opensearch
	// helpers use, so no silent data loss on an unexpected body).
	if (!("properties" in f) && !("geometry" in f)) return feature;
	const props = f.properties ?? {};

	// Positional [lon, lat, depth] → flat scalars (null when absent).
	const coords = Array.isArray(f.geometry?.coordinates)
		? (f.geometry?.coordinates as unknown[])
		: [];
	const [lon = null, lat = null, depth = null] = coords;

	const out: Record<string, unknown> = { id: f.id ?? null };
	for (const key of PROPERTY_KEEP) {
		if (key in props) out[key] = props[key];
	}
	out.lon = lon;
	out.lat = lat;
	out.depth = depth;
	return out;
}

export function transform(
	data: unknown,
	_ctx: { operation: string; domain: string },
): unknown {
	if (!data || typeof data !== "object") return data;

	// Whole FeatureCollection (restGet feeds) → transform each feature, keep
	// the envelope so the agent still sees `type`/`metadata`/`bbox`.
	if (Array.isArray((data as { features?: unknown }).features)) {
		return {
			...(data as Record<string, unknown>),
			features: (data as { features: unknown[] }).features.map(projectFeature),
		};
	}

	// Anything else (paginate per-item `queryEvents` feature) → project it.
	return projectFeature(data);
}
