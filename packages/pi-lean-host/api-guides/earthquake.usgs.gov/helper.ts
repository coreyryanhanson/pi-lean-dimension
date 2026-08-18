/**
 * USGS synthetic helper — named post-response `transform` for the
 * `transform-builtin` axis. Reshapes each GeoJSON `Feature`'s positional
 * `geometry.coordinates: [lon, lat, depth]` into flat `lon`/`lat`/`depth`,
 * and projects `properties` to a lean field set.
 *
 * Shapes handled:
 *  - a whole `FeatureCollection` (restGet feed — `transform` reshapes each
 *    `features[]` entry);
 *  - a single `Feature` (paginate per-item — `transform` runs on each item).
 * Anything else passes through untouched (non-lossy).
 */

interface GeoFeature {
	id?: unknown;
	geometry?: { coordinates?: number[] };
	properties?: Record<string, unknown>;
}

function reshapeFeature(feature: unknown): unknown {
	if (!feature || typeof feature !== "object") return feature;
	const f = feature as GeoFeature;
	const [lon, lat, depth] = f.geometry?.coordinates ?? [];
	const p = f.properties ?? {};
	return {
		id: f.id,
		mag: p["mag"],
		place: p["place"],
		time: p["time"],
		url: p["url"],
		status: p["status"],
		tsunami: p["tsunami"],
		magType: p["magType"],
		type: p["type"],
		title: p["title"],
		...(lon === undefined ? {} : { lon }),
		...(lat === undefined ? {} : { lat }),
		...(depth === undefined ? {} : { depth }),
	};
}

export function transform(
	data: unknown,
	_ctx: { operation: string; domain: string },
): unknown {
	// Whole FeatureCollection (restGet feed shape).
	if (
		data &&
		typeof data === "object" &&
		Array.isArray((data as { features?: unknown[] }).features)
	) {
		const d = data as { features: unknown[] };
		return { ...d, features: d.features.map(reshapeFeature) };
	}
	// Single Feature (paginate per-item shape).
	if (
		data &&
		typeof data === "object" &&
		Array.isArray((data as GeoFeature).geometry?.coordinates)
	) {
		return reshapeFeature(data);
	}
	return data;
}
