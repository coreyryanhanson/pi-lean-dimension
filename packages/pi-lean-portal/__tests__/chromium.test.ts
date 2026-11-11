import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runContractTests } from "./helpers/plugin-contract.js";
import { ChromiumPlugin } from "../backends/chromium/index.js";

const describeIfAvailable = (() => {
	try {
		return existsSync(chromium.executablePath()) ? describe : describe.skip;
	} catch {
		return describe.skip;
	}
})();

describeIfAvailable(
	"ChromiumPlugin contract tests",
	() => {
		runContractTests("chromium", () => new ChromiumPlugin(), {
			realBrowser: true,
			navigateTimeout: 30_000,
			navigationSettle: true,
		});
	},
	60_000,
);

// Pins the per-cookie limits assumed by core/shared/cookie-import.ts's
// engine-shape gate: MAX_COOKIE_BYTES (4096 name+value bytes, exclusive)
// and MAX_COOKIE_EXPIRES (year-9999 epoch-seconds cap) are real engine
// boundaries, not invented constants.
describeIfAvailable(
	"Chromium cookie engine limits",
	() => {
		const TASK_ID = "cookie-cap";
		let plugin: ChromiumPlugin;

		beforeAll(async () => {
			plugin = new ChromiumPlugin();
			const nav = await plugin.navigate("https://example.com/", TASK_ID, 30_000);
			if (!nav.success) throw new Error(nav.error ?? "navigate failed");
		});
		afterAll(async () => {
			await plugin.cleanupAll();
		});

		it("accepts a cookie of exactly 4096 name+value bytes", async () => {
			// 1-byte name + 4095-byte value = exactly the cap.
			const result = await plugin.addCookies(TASK_ID, [
				{ name: "c", value: "x".repeat(4095), domain: "example.com", path: "/" },
			]);
			expect(result.success).toBe(true);
			const got = await plugin.getCookies(TASK_ID);
			expect(got.success && got.cookies.some((c) => c.name === "c")).toBe(true);
		});

		it("rejects a cookie of 4097 name+value bytes", async () => {
			const result = await plugin.addCookies(TASK_ID, [
				{ name: "c", value: "x".repeat(4096), domain: "example.com", path: "/" },
			]);
			expect(result.success).toBe(false);
		});

		it("accepts the year-9999 expires cap and rejects above it", async () => {
			const atCap = await plugin.addCookies(TASK_ID, [
				{ name: "exp", value: "v", domain: "example.com", path: "/", expires: 253402300799 },
			]);
			expect(atCap.success).toBe(true);
			const overCap = await plugin.addCookies(TASK_ID, [
				{ name: "exp", value: "v", domain: "example.com", path: "/", expires: 253402300800 },
			]);
			expect(overCap.success).toBe(false);
		});
	},
	60_000,
);
