/**
 * FirefoxPlugin contract tests.
 *
 * Runs the shared `runContractTests` suite against the Node Firefox backend.
 * Skips automatically when Playwright Firefox is unavailable (no browser installed).
 */

import { existsSync } from "node:fs";
import { firefox } from "playwright";
import { describe } from "vitest";
import { runContractTests } from "./helpers/plugin-contract.js";
import { FirefoxPlugin } from "../backends/firefox/index.js";

function createFirefoxPlugin(): FirefoxPlugin {
	return new FirefoxPlugin();
}

// Skip the entire suite if Playwright Firefox isn't installed.
// We must check the file exists on disk — executablePath() returns a
// path even when the browser hasn't been installed.
const describeIfAvailable = (() => {
	try {
		const ffPath = firefox.executablePath();
		if (!existsSync(ffPath)) return describe.skip;
		return describe;
	} catch {
		return describe.skip;
	}
})();

describeIfAvailable(
	"FirefoxPlugin contract tests",
	() => {
		runContractTests("firefox", createFirefoxPlugin, {
			realBrowser: true,
			navigateTimeout: 30_000,
			navigationSettle: true,
		});
	},
	60_000,
);
