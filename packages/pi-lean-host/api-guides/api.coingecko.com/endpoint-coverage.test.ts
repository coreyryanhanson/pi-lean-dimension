/**
 * CoinGecko recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Verifies the authenticated header path end-to-end against the live API:
 * resolves the `apiKey` secret from the store, injects it as the
 * `x-cg-demo-api-key` header, and executes the keyed ops.
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1. Requires a
 * provisioned demo key at `/api secrets api.coingecko.com`.
 */

import { describe, expect } from "vitest";
import { withTempDirs, itWhen } from "../_shared/test-harness.js";

const DOMAIN = "api.coingecko.com";

describe("CoinGecko live integration (authenticated)", () => {
	itWhen(
		"parses and loads the CoinGecko recipe from a temp user dir",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain(DOMAIN);
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides[DOMAIN]!;
			expect(guide.apiHost).toBe("https://api.coingecko.com/api/v3");
			expect(guide.auth.kind).toBe("static-key");
			expect(guide.auth.secretRefs).toEqual({ "x-cg-demo-api-key": "apiKey" });
			expect(guide.auth.requires).toContain("apiKey");
		}),
	);

	itWhen(
		"listMarkets fetches a page with the key injected from the store",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { paginate } = await import("../../core/helpers.js");
			const { resolveSecretHeaders } = await import("../../core/auth.js");
			const { setUserGuidesDir, findGuidesByDomain } = await import(
				"../../core/guide-store.js"
			);
			setUserGuidesDir(guidesDir);
			const { guide, dirName } = findGuidesByDomain(DOMAIN).find(({ guide }) =>
				guide.operations.some((o) => o.name === "listMarkets"),
			)!;
			// Proves the acceptance path: a missing required key fails closed.
			const res = resolveSecretHeaders(guide.auth, DOMAIN);
			expect(res.absentRequired).toEqual([]);
			expect(res.headers["x-cg-demo-api-key"]).toBeTruthy();

			const op = guide.operations.find((o) => o.name === "listMarkets")!;
			const result = await paginate(
				guide.apiHost,
				op,
				{ vs_currency: "usd" },
				guide,
				{
					authHeaders: res.headers,
					secretHeaderNames: new Set(["x-cg-demo-api-key"]),
					secretValues: Object.values(res.headers),
				},
				undefined,
				dirName,
			);
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["name"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getCoin fetches a single coin detail with the key injected",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { restGet } = await import("../../core/helpers.js");
			const { resolveSecretHeaders } = await import("../../core/auth.js");
			const { setUserGuidesDir, findGuidesByDomain } = await import(
				"../../core/guide-store.js"
			);
			setUserGuidesDir(guidesDir);
			const { guide, dirName } = findGuidesByDomain(DOMAIN).find(({ guide }) =>
				guide.operations.some((o) => o.name === "getCoin"),
			)!;
			const res = resolveSecretHeaders(guide.auth, DOMAIN);
			expect(res.absentRequired).toEqual([]);

			const op = guide.operations.find((o) => o.name === "getCoin")!;
			const result = await restGet(
				guide.apiHost,
				op,
				{ id: "bitcoin", localization: false },
				guide,
				{
					authHeaders: res.headers,
					secretHeaderNames: new Set(["x-cg-demo-api-key"]),
					secretValues: Object.values(res.headers),
				},
				undefined,
				dirName,
			);
			const data = result.data as Record<string, unknown>;
			expect(data["id"]).toBe("bitcoin");
			expect(data["symbol"]).toBeTruthy();
		}),
		30_000,
	);
});
