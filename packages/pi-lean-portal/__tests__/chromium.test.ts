import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe } from "vitest";
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
