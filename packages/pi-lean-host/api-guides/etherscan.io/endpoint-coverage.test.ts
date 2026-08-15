/**
 * Etherscan V2 recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Verifies the A2 (query-param secret) path end-to-end against the live API:
 * resolves the `api_key` secret from the store, injects it as the `apikey`
 * query param BELOW the agent params map, and executes the keyed ops. The
 * surfaced URL must be redacted (`?apikey=***`) and the returned params map
 * must not contain the key.
 *
 * The parse test runs in bare CI (no network). Live endpoint tests are
 * skipped unless HOST_INTEGRATION=1 and a key is provisioned at
 * `/api secrets etherscan.io`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApiGuide } from "../../core/parse-api-guide.js";
import { withTempDirs, itWhen } from "../_shared/test-harness.js";

const DOMAIN = "etherscan.io";
const __dirname = dirname(fileURLToPath(import.meta.url));

// A stable mainnet address with activity (Ethereum Foundation).
const TEST_ADDRESS = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
// A well-known verified ERC-20 contract (USD Coin).
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
// A real transaction hash (from the Etherscan docs' getstatus example).
const TEST_TX =
	"0x15f8e5ea1079d9a0bb04a4c58ae5fe7654b5b2b4463375ff7ffb490aa0032f3a";
// A contract + block known to emit Transfer logs (the docs' getLogs example).
const LOG_ADDRESS = "0xbd3531da5cf5857e7cfaa92426877b022e612cf8";
const LOG_BLOCK = 12878196;
// A mainnet miner/validator address with mined blocks (from the docs).
const MINER = "0x9dd134d14d1e65f84b706d6f205cd5b1cd03a46b";

// Free tier is ~3 calls/s. The live tests fire several calls back-to-back,
// so throttle them to stay under the documented limit (a rate-limited call
// returns `{status:"0", result:"Max rate limit reached..."}` instead of data).
let lastLiveAt = 0;
async function throttleLive(): Promise<void> {
	const MIN_GAP = 450;
	const now = Date.now();
	const wait = Math.max(0, MIN_GAP - (now - lastLiveAt));
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastLiveAt = Date.now();
}

/** Resolve the stored key-injected query auth for a live restGet against the guide. */
async function authFor(guidesDir: string) {
	const { resolveSecretQueryParams } = await import("../../core/auth.js");
	const { setUserGuidesDir, findGuidesByDomain } = await import(
		"../../core/guide-store.js"
	);
	setUserGuidesDir(guidesDir);
	const { guide } = findGuidesByDomain(DOMAIN).find(({ guide }) =>
		guide.operations.some((o) => o.name === "getBalance"),
	)!;
	const res = resolveSecretQueryParams(guide.auth, DOMAIN);
	expect(res.absentRequired).toEqual([]);
	expect(res.queryParams["apikey"]).toBeTruthy();
	return {
		guide,
		secretQueryParams: res.queryParams,
		secretQueryParamNames: new Set(Object.keys(res.queryParams)),
		secretValues: Object.values(res.queryParams),
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

async function runPaginate(
	guidesDir: string,
	opName: string,
	params: Record<string, unknown>,
) {
	const { paginate } = await import("../../core/helpers.js");
	const { guide, ...auth } = await authFor(guidesDir);
	const op = guide.operations.find((o) => o.name === opName)!;
	return paginate(guide.apiHost, op, params, guide, auth);
}

describe("Etherscan V2 recipe", () => {
	it("parses cleanly and declares the A2 auth shape (no network)", () => {
		const raw = readFileSync(join(__dirname, "guide.md"), "utf-8");
		const result = parseApiGuide(raw, {
			file: join(__dirname, "guide.md"),
			filename: DOMAIN,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const guide = result.guide;
		expect(guide.apiHost).toBe("https://api.etherscan.io/v2/api");
		expect(guide.auth.kind).toBe("static-key");
		expect(guide.auth.secretQueryRefs).toEqual({ apikey: "api_key" });
		expect(guide.auth.requires).toContain("api_key");
		// The secret param must never be agent-suppliable — no op may declare it.
		for (const op of guide.operations) {
			expect(op.params["apikey"]).toBeUndefined();
		}
		// The expanded surface covers every module (comprehensive, CoinGecko-style).
		expect(guide.operations.length).toBeGreaterThanOrEqual(40);
		const names = new Set(guide.operations.map((o) => o.name));
		for (const expected of [
			"getBalance",
			"getBalanceMulti",
			"getTransactions",
			"getTokenTransfers",
			"getNftTransfers",
			"getErc1155Transfers",
			"getInternalTransactions",
			"getInternalTransactionsByBlock",
			"getInternalTransactionsByHash",
			"getMinedBlocks",
			"getBeaconWithdrawals",
			"getWithdrawalTransactions",
			"getDepositTransactions",
			"getBlockReward",
			"getBlockCountdown",
			"getBlockNumberByTimestamp",
			"getAbi",
			"getSourceCode",
			"getContractCreation",
			"getGasOracle",
			"getGasEstimate",
			"getBlockNumber",
			"getBlockByNumber",
			"getBlockTransactionCountByNumber",
			"getUncleByBlockNumberAndIndex",
			"getTransactionByHash",
			"getTransactionByBlockNumberAndIndex",
			"getTransactionCount",
			"getTransactionReceipt",
			"getCall",
			"getCode",
			"getStorageAt",
			"getGasPrice",
			"getLogs",
			"getTxStatus",
			"getTxReceiptStatus",
			"getEthSupply",
			"getEthSupply2",
			"getEthPrice",
			"getChainSize",
			"getNodeCount",
			"getNodeCountHistory",
			"getTokenSupply",
			"getTokenBalance",
			"getApiUsage",
		]) {
			expect(names.has(expected), `missing op ${expected}`).toBe(true);
		}
		const tx = guide.operations.find((o) => o.name === "getTransactions")!;
		expect(tx.via).toBe("paginate");
		expect(tx.pagination?.style).toBe("page");
		expect(tx.pagination?.pageParam).toBe("page");
		expect(tx.pagination?.pageSizeParam).toBe("offset");
		expect(tx.pagination?.itemsPath).toBe("result");
		// getApiUsage is chain-agnostic — must not declare chainid.
		const usage = guide.operations.find((o) => o.name === "getApiUsage")!;
		expect(usage.params["chainid"]).toBeUndefined();
	});

	itWhen(
		"getBalance fetches with the key injected below the params and the URL redacted",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const { guide, ...auth } = await authFor(guidesDir);
			const op = guide.operations.find((o) => o.name === "getBalance")!;
			const { restGet } = await import("../../core/helpers.js");
			const result = await restGet(
				guide.apiHost,
				op,
				{ address: TEST_ADDRESS },
				guide,
				auth,
			);
			const data = result.data as { status: string; result: string };
			expect(data.status).toBe("1");
			expect(data.result).toBeTruthy();
			// A2 URL channel: the surfaced URL is redacted, the raw key never appears.
			expect(result.url).toContain("apikey=***");
			for (const v of auth.secretValues) {
				expect(result.url).not.toContain(v);
			}
			// A2 params channel: the returned map is agent-supplied only.
			expect(result.params["apikey"]).toBeUndefined();
		}),
		30_000,
	);

	itWhen(
		"getBalanceMulti fetches several balances in one call",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getBalanceMulti", {
				address: `${TEST_ADDRESS},0x0000000000000000000000000000000000000000`,
			});
			const data = result.data as { status: string; result: unknown[] };
			expect(data.status).toBe("1");
			expect(Array.isArray(data.result)).toBe(true);
			expect(data.result.length).toBe(2);
			expect(result.url).toContain("apikey=***");
		}),
		30_000,
	);

	itWhen(
		"getMinedBlocks paginates blocks validated by a miner",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runPaginate(guidesDir, "getMinedBlocks", {
				address: MINER,
			});
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["blockNumber"]).toBeTruthy();
			for (const url of result.urls) {
				expect(url).toContain("apikey=***");
			}
			expect(result.params["apikey"]).toBeUndefined();
		}),
		30_000,
	);

	itWhen(
		"getBlockNumber fetches the latest block (proxy hex result)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getBlockNumber", {});
			const data = result.data as { result?: string };
			expect(Number.parseInt(data.result ?? "0x0", 16)).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getBlockByNumber fetches a block by tag",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getBlockByNumber", {
				tag: "latest",
				boolean: "false",
			});
			const data = result.data as { result?: { number: string } };
			expect(Number.parseInt(data.result?.number ?? "0x0", 16)).toBeGreaterThan(
				0,
			);
		}),
		30_000,
	);

	itWhen(
		"getBlockNumberByTimestamp resolves a historical block",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getBlockNumberByTimestamp", {
				timestamp: "1600000000",
				closest: "before",
			});
			const data = result.data as { status: string; result: string };
			expect(data.status).toBe("1");
			expect(Number.parseInt(data.result)).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getGasOracle fetches live gas prices",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getGasOracle", {});
			const data = result.data as {
				status: string;
				result: { SafeGasPrice: string };
			};
			expect(data.status).toBe("1");
			expect(Number(data.result.SafeGasPrice)).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getGasPrice fetches the current gas price (proxy)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getGasPrice", {});
			const data = result.data as { result?: string };
			expect(Number.parseInt(data.result ?? "0x0", 16)).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getEthSupply and getEthPrice fetch network stats",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const supply = await runRestGet(guidesDir, "getEthSupply", {});
			const s = supply.data as { status: string; result: string };
			expect(s.status).toBe("1");
			expect(Number.parseInt(s.result)).toBeGreaterThan(0);
			await throttleLive();
			const price = await runRestGet(guidesDir, "getEthPrice", {});
			const p = price.data as { status: string; result: { ethusd: string } };
			expect(p.status).toBe("1");
			expect(Number(p.result.ethusd)).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getNodeCount fetches the discoverable node count",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getNodeCount", {});
			const data = result.data as {
				status: string;
				result: { TotalNodeCount: string };
			};
			expect(data.status).toBe("1");
			expect(Number.parseInt(data.result.TotalNodeCount)).toBeGreaterThan(0);
		}),
		30_000,
	);

	itWhen(
		"getTokenSupply and getTokenBalance read ERC-20 data",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const supply = await runRestGet(guidesDir, "getTokenSupply", {
				contractaddress: USDC,
			});
			const s = supply.data as { status: string; result: string };
			expect(s.status).toBe("1");
			expect(Number.parseInt(s.result)).toBeGreaterThan(0);
			await throttleLive();
			const bal = await runRestGet(guidesDir, "getTokenBalance", {
				contractaddress: USDC,
				address: TEST_ADDRESS,
			});
			const b = bal.data as { status: string; result: string };
			expect(b.status).toBe("1");
			expect(b.result).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getAbi and getSourceCode read a verified contract",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const abi = await runRestGet(guidesDir, "getAbi", {
				address: USDC,
			});
			const a = abi.data as { status: string; result: string };
			expect(a.status).toBe("1");
			expect(a.result).toContain("function");
			await throttleLive();
			const src = await runRestGet(guidesDir, "getSourceCode", {
				address: USDC,
			});
			const s = src.data as { status: string; result: unknown[] };
			expect(s.status).toBe("1");
			expect(Array.isArray(s.result)).toBe(true);
			expect(
				(s.result[0] as { ContractName: string }).ContractName,
			).toBeTruthy();
		}),
		30_000,
	);

	itWhen(
		"getTransactionByHash, getTransactionReceipt and getTxStatus read a tx",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const tx = await runRestGet(guidesDir, "getTransactionByHash", {
				txhash: TEST_TX,
			});
			const t = tx.data as { result?: { hash: string } };
			expect(t.result?.hash).toBe(TEST_TX);
			await throttleLive();
			const receipt = await runRestGet(guidesDir, "getTransactionReceipt", {
				txhash: TEST_TX,
			});
			const r = receipt.data as { result?: { transactionHash: string } };
			expect(r.result?.transactionHash).toBe(TEST_TX);
			await throttleLive();
			const status = await runRestGet(guidesDir, "getTxStatus", {
				txhash: TEST_TX,
			});
			const st = status.data as { status: string; result: { isError: string } };
			expect(st.status).toBe("1");
			expect(st.result.isError).toBeDefined();
		}),
		30_000,
	);

	itWhen(
		"getCall executes a view call (USDC balanceOf)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getCall", {
				to: USDC,
				data: `0x70a08231000000000000000000000000${TEST_ADDRESS.slice(2)}`,
			});
			const data = result.data as { result?: string };
			expect(data.result).toBeTruthy();
			expect(data.result!.startsWith("0x")).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getCode reads deployed bytecode",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getCode", {
				address: USDC,
			});
			const data = result.data as { result?: string };
			expect(data.result).toBeTruthy();
			expect(data.result!.length).toBeGreaterThan(2);
		}),
		30_000,
	);

	itWhen(
		"getTransactionCount read an address nonce",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getTransactionCount", {
				address: TEST_ADDRESS,
				tag: "latest",
			});
			const data = result.data as { result?: string };
			// Proxy endpoints return a JSON-RPC envelope; the nonce is a hex string
			// (may legitimately be 0x0 for a quiet address). Assert shape, not value.
			expect(data.result).toBeDefined();
			expect(data.result!.startsWith("0x")).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getLogs fetches event logs for a block range",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runPaginate(guidesDir, "getLogs", {
				address: LOG_ADDRESS,
				fromBlock: String(LOG_BLOCK),
				toBlock: String(LOG_BLOCK),
			});
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["address"]).toBe(LOG_ADDRESS.toLowerCase());
			for (const url of result.urls) {
				expect(url).toContain("apikey=***");
			}
			expect(result.params["apikey"]).toBeUndefined();
		}),
		30_000,
	);

	itWhen(
		"getApiUsage reports credits (chain-agnostic op)",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runRestGet(guidesDir, "getApiUsage", {});
			const data = result.data as {
				status: string;
				result: { creditsUsed: number };
			};
			expect(data.status).toBe("1");
			expect(typeof data.result.creditsUsed).toBe("number");
			// No chainid on the chain-agnostic op; the key is still injected.
			expect(result.url).toContain("apikey=***");
			expect(result.params["apikey"]).toBeUndefined();
		}),
		30_000,
	);

	itWhen(
		"getTransactions paginates a page of txs with the key injected",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runPaginate(guidesDir, "getTransactions", {
				address: TEST_ADDRESS,
			});
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			const first = result.items[0] as Record<string, unknown>;
			expect(first["hash"]).toBeTruthy();
			// Every surfaced URL is redacted; the params map is agent-supplied only.
			for (const url of result.urls) {
				expect(url).toContain("apikey=***");
			}
			expect(result.params["apikey"]).toBeUndefined();
		}),
		30_000,
	);

	itWhen(
		"getTokenTransfers paginates ERC-20 transfers with the key injected",
		withTempDirs(DOMAIN)(async ({ guidesDir }) => {
			await throttleLive();
			const result = await runPaginate(guidesDir, "getTokenTransfers", {
				address: TEST_ADDRESS,
				contractaddress: USDC,
			});
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			for (const url of result.urls) {
				expect(url).toContain("apikey=***");
			}
			expect(result.params["apikey"]).toBeUndefined();
		}),
		30_000,
	);
});
