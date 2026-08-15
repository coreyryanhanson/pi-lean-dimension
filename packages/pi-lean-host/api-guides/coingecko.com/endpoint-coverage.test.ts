/**
 * CoinGecko recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Verifies the authenticated header path end-to-end against the live API:
 * resolves the `api_key` secret from the store, injects it as the
 * `x-cg-demo-api-key` header, and executes the keyed ops.
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1. Requires a
 * provisioned demo key at `/api secrets coingecko.com`.
 */

import { describe, expect, it } from "vitest";
import { withTempDirs, itWhen } from "../_shared/test-harness.js";

const DOMAIN = "coingecko.com";

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Resolve the stored key-injected auth for a live restGet against the guide. */
async function authFor(guidesDir: string) {
	const { resolveSecretHeaders } = await import("../../core/auth.js");
	const { setUserGuidesDir, findGuidesByDomain } = await import(
		"../../core/guide-store.js"
	);
	setUserGuidesDir(guidesDir);
	const { guide } = findGuidesByDomain(DOMAIN).find(({ guide }) =>
		guide.operations.some((o) => o.name === "getSimplePrice"),
	)!;
	const res = resolveSecretHeaders(guide.auth, DOMAIN);
	expect(res.absentRequired).toEqual([]);
	expect(res.headers["x-cg-demo-api-key"]).toBeTruthy();
	return {
		guide,
		authHeaders: res.headers,
		secretHeaderNames: new Set(["x-cg-demo-api-key"]),
		secretValues: Object.values(res.headers),
	};
}

async function runRestGet(
	guidesDir: string,
	opName: string,
	params: Record<string, unknown>,
) {
	const { restGet } = await import("../../core/helpers.js");
	const { guide, ...auth } = await authFor(guidesDir);
	const op = guide.operations.find((o) => o.name === opName)!;
	return restGet(guide.apiHost, op, params, guide, auth);
}

describe("CoinGecko live integration (authenticated)", () => {
	it(
		"declares the full set of operations",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const guide = loadApiGuidesFromDir(guidesDir).guides[DOMAIN]!;
			const names = guide.operations.map((o) => o.name);
			expect(names).toEqual(
				expect.arrayContaining([
					"listMarkets",
					"getCoin",
					"getCoinByContract",
					"getTickers",
					"getHistory",
					"getMarketChart",
					"getMarketChartRange",
					"getOhlc",
					"getContractMarketChart",
					"getContractMarketChartRange",
					"getSimplePrice",
					"getTokenPrice",
					"getSupportedCurrencies",
					"getExchangeRates",
					"search",
					"getTrending",
					"getGlobal",
					"getGlobalDefi",
					"getCategoriesList",
					"getCategories",
					"getCoinList",
					"getAssetPlatforms",
					"getExchangesList",
					"getExchanges",
					"getExchange",
					"getExchangeTickers",
					"getExchangeVolumeChart",
					"getDerivativesExchangesList",
					"getDerivatives",
					"getDerivativesExchanges",
					"getDerivativesExchange",
					"getNftsList",
					"getNft",
					"getNftByContract",
					"getEntitiesList",
					"getTreasuryByCoin",
					"getTreasuryByEntity",
					"getTreasuryHoldingChart",
					"getTreasuryTransactions",
				]),
			);
			const price = guide.operations.find((o) => o.name === "getSimplePrice")!;
			expect(price.path).toBe("/simple/price");
			expect(price.via).toBe("restGet");
			expect(price.params["vs_currencies"]!.required).toBe(true);

			const token = guide.operations.find((o) => o.name === "getTokenPrice")!;
			expect(token.path).toBe("/simple/token_price/{id}");
			expect(token.pathParams).toEqual(["id"]);
			expect(token.params["contract_addresses"]!.required).toBe(true);

			const contract = guide.operations.find(
				(o) => o.name === "getCoinByContract",
			)!;
			expect(contract.path).toBe("/coins/{id}/contract/{contract_address}");
			expect(contract.via).toBe("restGet");
			expect(contract.pathParams).toEqual(["id", "contract_address"]);

			const tickers = guide.operations.find((o) => o.name === "getTickers")!;
			expect(tickers.path).toBe("/coins/{id}/tickers");
			expect(tickers.via).toBe("restGet");
			expect(tickers.params["page"]!.default).toBe(1);

			const history = guide.operations.find((o) => o.name === "getHistory")!;
			expect(history.path).toBe("/coins/{id}/history");
			expect(history.params["date"]!.required).toBe(true);

			const marketChart = guide.operations.find(
				(o) => o.name === "getMarketChart",
			)!;
			expect(marketChart.path).toBe("/coins/{id}/market_chart");
			expect(marketChart.via).toBe("restGet");
			expect(marketChart.params["days"]!.required).toBe(true);

			const marketChartRange = guide.operations.find(
				(o) => o.name === "getMarketChartRange",
			)!;
			expect(marketChartRange.path).toBe("/coins/{id}/market_chart/range");
			expect(marketChartRange.params["from"]!.required).toBe(true);
			expect(marketChartRange.params["to"]!.required).toBe(true);

			const ohlc = guide.operations.find((o) => o.name === "getOhlc")!;
			expect(ohlc.path).toBe("/coins/{id}/ohlc");
			expect(ohlc.via).toBe("restGet");
			expect(ohlc.params["days"]!.required).toBe(true);

			const contractChart = guide.operations.find(
				(o) => o.name === "getContractMarketChart",
			)!;
			expect(contractChart.path).toBe(
				"/coins/{id}/contract/{contract_address}/market_chart",
			);
			expect(contractChart.pathParams).toEqual(["id", "contract_address"]);

			const contractChartRange = guide.operations.find(
				(o) => o.name === "getContractMarketChartRange",
			)!;
			expect(contractChartRange.path).toBe(
				"/coins/{id}/contract/{contract_address}/market_chart/range",
			);
			expect(contractChartRange.pathParams).toEqual(["id", "contract_address"]);

			const search = guide.operations.find((o) => o.name === "search")!;
			expect(search.path).toBe("/search");
			expect(search.via).toBe("restGet");
			expect(search.params["query"]!.required).toBe(true);

			const trending = guide.operations.find((o) => o.name === "getTrending")!;
			expect(trending.path).toBe("/search/trending");
			expect(trending.via).toBe("restGet");

			const global = guide.operations.find((o) => o.name === "getGlobal")!;
			expect(global.path).toBe("/global");
			expect(global.via).toBe("restGet");

			const globalDefi = guide.operations.find(
				(o) => o.name === "getGlobalDefi",
			)!;
			expect(globalDefi.path).toBe("/global/decentralized_finance_defi");
			expect(globalDefi.via).toBe("restGet");

			const categoriesList = guide.operations.find(
				(o) => o.name === "getCategoriesList",
			)!;
			expect(categoriesList.path).toBe("/coins/categories/list");
			expect(categoriesList.via).toBe("restGet");

			const categories = guide.operations.find(
				(o) => o.name === "getCategories",
			)!;
			expect(categories.path).toBe("/coins/categories");
			expect(categories.via).toBe("restGet");
			expect(categories.params["order"]!.default).toBe("market_cap_desc");

			const coinList = guide.operations.find((o) => o.name === "getCoinList")!;
			expect(coinList.path).toBe("/coins/list");
			expect(coinList.via).toBe("restGet");
			expect(coinList.params["include_platform"]!.default).toBe(false);

			const assetPlatforms = guide.operations.find(
				(o) => o.name === "getAssetPlatforms",
			)!;
			expect(assetPlatforms.path).toBe("/asset_platforms");
			expect(assetPlatforms.via).toBe("restGet");

			const exchangesList = guide.operations.find(
				(o) => o.name === "getExchangesList",
			)!;
			expect(exchangesList.path).toBe("/exchanges/list");
			expect(exchangesList.via).toBe("restGet");

			const exchanges = guide.operations.find(
				(o) => o.name === "getExchanges",
			)!;
			expect(exchanges.path).toBe("/exchanges");
			expect(exchanges.via).toBe("paginate");
			expect(exchanges.pagination?.pageSizeParam).toBe("per_page");
			expect(exchanges.pagination?.pageSize).toBe(100);

			const exchange = guide.operations.find((o) => o.name === "getExchange")!;
			expect(exchange.path).toBe("/exchanges/{id}");
			expect(exchange.via).toBe("restGet");
			expect(exchange.pathParams).toEqual(["id"]);

			const exchangeTickers = guide.operations.find(
				(o) => o.name === "getExchangeTickers",
			)!;
			expect(exchangeTickers.path).toBe("/exchanges/{id}/tickers");
			expect(exchangeTickers.via).toBe("restGet");
			expect(exchangeTickers.params["depth"]!.default).toBe(false);

			const exchangeVolumeChart = guide.operations.find(
				(o) => o.name === "getExchangeVolumeChart",
			)!;
			expect(exchangeVolumeChart.path).toBe("/exchanges/{id}/volume_chart");
			expect(exchangeVolumeChart.via).toBe("restGet");
			expect(exchangeVolumeChart.params["days"]!.required).toBe(true);

			const derivExchangesList = guide.operations.find(
				(o) => o.name === "getDerivativesExchangesList",
			)!;
			expect(derivExchangesList.path).toBe("/derivatives/exchanges/list");
			expect(derivExchangesList.via).toBe("restGet");

			const derivatives = guide.operations.find(
				(o) => o.name === "getDerivatives",
			)!;
			expect(derivatives.path).toBe("/derivatives");
			expect(derivatives.via).toBe("restGet");

			const derivExchanges = guide.operations.find(
				(o) => o.name === "getDerivativesExchanges",
			)!;
			expect(derivExchanges.path).toBe("/derivatives/exchanges");
			expect(derivExchanges.via).toBe("paginate");
			expect(derivExchanges.pagination?.pageSizeParam).toBe("per_page");
			expect(derivExchanges.pagination?.pageSize).toBe(100);

			const derivExchange = guide.operations.find(
				(o) => o.name === "getDerivativesExchange",
			)!;
			expect(derivExchange.path).toBe("/derivatives/exchanges/{id}");
			expect(derivExchange.via).toBe("restGet");
			expect(derivExchange.pathParams).toEqual(["id"]);

			const nftsList = guide.operations.find((o) => o.name === "getNftsList")!;
			expect(nftsList.path).toBe("/nfts/list");
			expect(nftsList.via).toBe("paginate");
			expect(nftsList.pagination?.pageSizeParam).toBe("per_page");
			expect(nftsList.pagination?.pageSize).toBe(100);

			const nft = guide.operations.find((o) => o.name === "getNft")!;
			expect(nft.path).toBe("/nfts/{id}");
			expect(nft.via).toBe("restGet");
			expect(nft.pathParams).toEqual(["id"]);

			const nftByContract = guide.operations.find(
				(o) => o.name === "getNftByContract",
			)!;
			expect(nftByContract.path).toBe(
				"/nfts/{asset_platform_id}/contract/{contract_address}",
			);
			expect(nftByContract.via).toBe("restGet");
			expect(nftByContract.pathParams).toEqual([
				"asset_platform_id",
				"contract_address",
			]);

			const entitiesList = guide.operations.find(
				(o) => o.name === "getEntitiesList",
			)!;
			expect(entitiesList.path).toBe("/entities/list");
			expect(entitiesList.via).toBe("restGet");

			const treasuryByCoin = guide.operations.find(
				(o) => o.name === "getTreasuryByCoin",
			)!;
			expect(treasuryByCoin.path).toBe("/{entity}/public_treasury/{coin_id}");
			expect(treasuryByCoin.via).toBe("paginate");
			expect(treasuryByCoin.pathParams).toEqual(["entity", "coin_id"]);
			expect(treasuryByCoin.pagination?.pageSizeParam).toBe("per_page");

			const treasuryByEntity = guide.operations.find(
				(o) => o.name === "getTreasuryByEntity",
			)!;
			expect(treasuryByEntity.path).toBe("/public_treasury/{entity_id}");
			expect(treasuryByEntity.via).toBe("restGet");
			expect(treasuryByEntity.pathParams).toEqual(["entity_id"]);

			const treasuryChart = guide.operations.find(
				(o) => o.name === "getTreasuryHoldingChart",
			)!;
			expect(treasuryChart.path).toBe(
				"/public_treasury/{entity_id}/{coin_id}/holding_chart",
			);
			expect(treasuryChart.via).toBe("restGet");
			expect(treasuryChart.pathParams).toEqual(["entity_id", "coin_id"]);
			expect(treasuryChart.params["days"]!.required).toBe(true);

			const treasuryTx = guide.operations.find(
				(o) => o.name === "getTreasuryTransactions",
			)!;
			expect(treasuryTx.path).toBe(
				"/public_treasury/{entity_id}/transaction_history",
			);
			expect(treasuryTx.via).toBe("restGet");
			expect(treasuryTx.pathParams).toEqual(["entity_id"]);
		}),
	);

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
			expect(guide.auth.secretRefs).toEqual({ "x-cg-demo-api-key": "api_key" });
			expect(guide.auth.requires).toContain("api_key");
		}),
	);

	itWhen(
		"listMarkets fetches a page with the key injected from the store",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { paginate } = await import("../../core/helpers.js");
			const { guide, ...auth } = await authFor(guidesDir);
			const op = guide.operations.find((o) => o.name === "listMarkets")!;
			const result = await paginate(
				guide.apiHost,
				op,
				{ vs_currency: "usd" },
				guide,
				auth,
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
			const result = await runRestGet(guidesDir, "getCoin", {
				id: "bitcoin",
				localization: false,
			});
			const data = result.data as Record<string, unknown>;
			expect(data["id"]).toBe("bitcoin");
			expect(data["symbol"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getCoinByContract fetches coin data by contract address",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getCoinByContract", {
				id: "ethereum",
				contract_address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
			});
			const data = result.data as Record<string, unknown>;
			expect(data["symbol"]).toBe("wbtc");
		}),
		30_000,
	);

	itWhen(
		"getTickers fetches coin tickers",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getTickers", {
				id: "bitcoin",
			});
			const data = result.data as { tickers: unknown[] };
			expect(Array.isArray(data["tickers"])).toBe(true);
			expect(data["tickers"].length).toBeGreaterThan(0);
			const first = data["tickers"][0] as Record<string, unknown>;
			expect(first["base"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getHistory fetches a historical snapshot at a date",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const d = new Date(Date.now() - 86_400_000);
			const date = `${String(d.getDate()).padStart(2, "0")}-${String(
				d.getMonth() + 1,
			).padStart(2, "0")}-${d.getFullYear()}`;
			const result = await runRestGet(guidesDir, "getHistory", {
				id: "bitcoin",
				date,
			});
			const data = result.data as Record<string, unknown>;
			expect(data["id"]).toBe("bitcoin");
			expect(data["market_data"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getMarketChart fetches price/market-cap/volume series",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getMarketChart", {
				id: "bitcoin",
				days: "1",
			});
			const data = result.data as { prices: unknown[] };
			expect(Array.isArray(data["prices"])).toBe(true);
			expect(data["prices"].length).toBeGreaterThan(0);
			expect((data["prices"][0] as unknown[]).length).toBe(2);
		}),
		30_000,
	);

	itWhen(
		"getMarketChartRange fetches a series within a time range",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getMarketChartRange", {
				id: "bitcoin",
				from: isoDate(new Date(Date.now() - 3 * 86_400_000)),
				to: isoDate(new Date(Date.now() - 86_400_000)),
			});
			const data = result.data as { prices: unknown[] };
			expect(Array.isArray(data["prices"])).toBe(true);
			expect(data["prices"].length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getOhlc fetches candlestick rows",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getOhlc", {
				id: "bitcoin",
				days: "1",
			});
			const data = result.data as unknown[][];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]!.length).toBe(5); // [ts, open, high, low, close]
		}),
		30_000,
	);

	itWhen(
		"getContractMarketChart fetches a token chart by contract address",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getContractMarketChart", {
				id: "ethereum",
				contract_address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
				days: "1",
			});
			const data = result.data as { prices: unknown[] };
			expect(Array.isArray(data["prices"])).toBe(true);
			expect(data["prices"].length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getContractMarketChartRange fetches a token chart within a time range",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(
				guidesDir,
				"getContractMarketChartRange",
				{
					id: "ethereum",
					contract_address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
					from: isoDate(new Date(Date.now() - 3 * 86_400_000)),
					to: isoDate(new Date(Date.now() - 86_400_000)),
				},
			);
			const data = result.data as { prices: unknown[] };
			expect(Array.isArray(data["prices"])).toBe(true);
			expect(data["prices"].length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getSimplePrice fetches live prices with the key injected",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getSimplePrice", {
				ids: "bitcoin,ethereum",
				vs_currencies: "usd",
			});
			const data = result.data as Record<string, unknown>;
			expect(data["bitcoin"]).toBeTruthy();
			expect(data["ethereum"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getTokenPrice fetches token price by contract address",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getTokenPrice", {
				id: "ethereum",
				contract_addresses: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
				vs_currencies: "usd",
			});
			const data = result.data as Record<string, unknown>;
			const addr = Object.keys(data)[0];
			expect(addr).toBeTruthy();
			expect((data[addr!] as Record<string, unknown>)["usd"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getSupportedCurrencies returns an array of currency codes",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getSupportedCurrencies", {});
			const data = result.data as string[];
			expect(Array.isArray(data)).toBe(true);
			expect(data).toContain("usd");
		}),
		30_000,
	);

	itWhen(
		"getExchangeRates returns BTC exchange rates",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getExchangeRates", {});
			const data = result.data as { rates: Record<string, unknown> };
			expect(data["rates"]).toBeTruthy();
			expect(data["rates"]["btc"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"search returns grouped matches for a query",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "search", {
				query: "bitcoin",
			});
			const data = result.data as { coins: unknown[] };
			expect(Array.isArray(data["coins"])).toBe(true);
			expect(data["coins"].length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getTrending returns trending coins, nfts and categories",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getTrending", {});
			const data = result.data as { coins: unknown[] };
			expect(Array.isArray(data["coins"])).toBe(true);
			expect(data["coins"].length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getGlobal returns aggregate crypto market data",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getGlobal", {});
			const data = result.data as { data: Record<string, unknown> };
			expect(data["data"]).toBeTruthy();
			expect(
				(data["data"] as Record<string, unknown>)["active_cryptocurrencies"],
			).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getGlobalDefi returns aggregate DeFi market data",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getGlobalDefi", {});
			const data = result.data as { data: Record<string, unknown> };
			expect(data["data"]).toBeTruthy();
			expect(
				(data["data"] as Record<string, unknown>)["defi_market_cap"],
			).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getCategoriesList returns the flat category ID map",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getCategoriesList", {});
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]!["category_id"]).toBeTruthy();
			expect(data[0]!["name"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getCategories returns categories with market data",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getCategories", {});
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]!["id"]).toBeTruthy();
			expect(data[0]!["market_cap"]).toBeDefined();
		}),
		30_000,
	);

	itWhen(
		"getCoinList returns the coin ID/symbol/name map",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getCoinList", {});
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(1000);
			expect(data.some((c) => c["id"] === "bitcoin")).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getAssetPlatforms returns the supported chain map",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getAssetPlatforms", {});
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data.some((p) => p["id"] === "ethereum")).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getExchangesList returns the exchange ID map",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getExchangesList", {});
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]!["id"]).toBeTruthy();
			expect(data[0]!["name"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getExchanges fetches a page of exchanges with the key injected",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { paginate } = await import("../../core/helpers.js");
			const { guide, ...auth } = await authFor(guidesDir);
			const op = guide.operations.find((o) => o.name === "getExchanges")!;
			const result = await paginate(guide.apiHost, op, {}, guide, auth);
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["name"]).toBeTruthy();
			expect(first["trust_score"]).toBeDefined();
		}),
		30_000,
	);

	itWhen(
		"getExchange fetches exchange data by id",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getExchange", {
				id: "binance",
			});
			const data = result.data as { name: string };
			expect(data["name"]).toBe("Binance");
		}),
		30_000,
	);

	itWhen(
		"getExchangeTickers fetches an exchange's tickers",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getExchangeTickers", {
				id: "binance",
			});
			const data = result.data as { tickers: unknown[] };
			expect(Array.isArray(data["tickers"])).toBe(true);
			expect(data["tickers"].length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getExchangeVolumeChart fetches a historical volume series",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getExchangeVolumeChart", {
				id: "binance",
				days: "1",
			});
			const data = result.data as unknown[][];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect((data[0] as unknown[]).length).toBe(2); // [timestamp, volume_btc]
		}),
		30_000,
	);

	itWhen(
		"getDerivativesExchangesList returns the derivative exchange ID map",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(
				guidesDir,
				"getDerivativesExchangesList",
				{},
			);
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]!["id"]).toBeTruthy();
			expect(data[0]!["name"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getDerivatives returns all derivative tickers",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getDerivatives", {});
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]!["symbol"]).toBeTruthy();
			expect(data[0]!["market"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getDerivativesExchanges fetches a page of derivatives exchanges",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { paginate } = await import("../../core/helpers.js");
			const { guide, ...auth } = await authFor(guidesDir);
			const op = guide.operations.find(
				(o) => o.name === "getDerivativesExchanges",
			)!;
			const result = await paginate(guide.apiHost, op, {}, guide, auth);
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["name"]).toBeTruthy();
			expect(first["open_interest_btc"]).toBeDefined();
		}),
		30_000,
	);

	itWhen(
		"getDerivativesExchange fetches a derivatives exchange by id",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getDerivativesExchange", {
				id: "binance_futures",
			});
			const data = result.data as Record<string, unknown>;
			expect(data["name"]).toBeTruthy();
			expect(data["open_interest_btc"]).toBeDefined();
		}),
		30_000,
	);

	itWhen(
		"getNftsList fetches a page of NFT collections",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { paginate } = await import("../../core/helpers.js");
			const { guide, ...auth } = await authFor(guidesDir);
			const op = guide.operations.find((o) => o.name === "getNftsList")!;
			const result = await paginate(guide.apiHost, op, {}, guide, auth);
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["id"]).toBeTruthy();
			expect(first["name"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getNft fetches NFT collection data by id",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getNft", {
				id: "pudgy-penguins",
			});
			const data = result.data as Record<string, unknown>;
			expect(data["name"]).toBeTruthy();
			expect(data["floor_price"]).toBeDefined();
		}),
		30_000,
	);

	itWhen(
		"getNftByContract fetches NFT collection data by contract address",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getNftByContract", {
				asset_platform_id: "ethereum",
				contract_address: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
			});
			const data = result.data as { name: string };
			expect(data["name"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getEntitiesList returns the treasury entity ID map",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getEntitiesList", {});
			const data = result.data as Record<string, unknown>[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]!["id"]).toBeTruthy();
			expect(data[0]!["name"]).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getTreasuryByCoin fetches treasury holdings by coin id",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const { paginate } = await import("../../core/helpers.js");
			const { guide, ...auth } = await authFor(guidesDir);
			const op = guide.operations.find((o) => o.name === "getTreasuryByCoin")!;
			const result = await paginate(
				guide.apiHost,
				op,
				{ entity: "companies", coin_id: "bitcoin" },
				guide,
				auth,
			);
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["total_holdings"]).toBeDefined();
			expect(first["total_value_usd"]).toBeDefined();
		}),
		30_000,
	);

	itWhen(
		"getTreasuryByEntity fetches an entity's treasury record",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getTreasuryByEntity", {
				entity_id: "strategy",
			});
			const data = result.data as Record<string, unknown> & {
				holdings: unknown[];
			};
			expect(data["name"]).toBeTruthy();
			expect(Array.isArray(data["holdings"])).toBe(true);
			expect(data["holdings"].length).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getTreasuryHoldingChart fetches a holdings chart series",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getTreasuryHoldingChart", {
				entity_id: "strategy",
				coin_id: "bitcoin",
				days: "30",
			});
			const data = result.data as { holdings: unknown[][] };
			expect(Array.isArray(data["holdings"])).toBe(true);
			expect(data["holdings"].length).toBeGreaterThan(0);
			expect((data["holdings"][0] as unknown[]).length).toBe(2);
		}),
		30_000,
	);

	itWhen(
		"getTreasuryTransactions fetches an entity's transaction history",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			const result = await runRestGet(guidesDir, "getTreasuryTransactions", {
				entity_id: "strategy",
				coin_ids: "bitcoin",
			});
			const data = result.data as { transactions: unknown[] };
			expect(Array.isArray(data["transactions"])).toBe(true);
			expect(data["transactions"].length).toBeGreaterThan(0);
		}),
		30_000,
	);
});
