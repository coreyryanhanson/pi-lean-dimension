import { existsSync } from "node:fs";
import { firefox } from "playwright";
import { describe } from "vitest";
import { runContractTests } from "./helpers/plugin-contract.js";
import { FirefoxPlugin } from "../backends/firefox/index.js";

const describeIfAvailable = (() => {
	try {
		return existsSync(firefox.executablePath()) ? describe : describe.skip;
	} catch {
		return describe.skip;
	}
})();

describeIfAvailable(
	"FirefoxPlugin contract tests",
	() => {
		runContractTests("firefox", () => new FirefoxPlugin(), {
			realBrowser: true,
			navigateTimeout: 30_000,
			navigationSettle: true,
		});
	},
	60_000,
);
