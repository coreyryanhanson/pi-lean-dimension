/**
 * Install-error tagging — a missing browser executable surfaces as a
 * NavigateResult with `errorKind: "not-installed"` (consumed by
 * tools/browser-navigate.ts to offer /web install), while ordinary launch
 * failures stay untagged. Structural: launchBrowser is stubbed, no browser.
 */

import { describe, it, expect } from "vitest";
import type { Browser } from "playwright";
import { PlaywrightPluginBase } from "../backends/playwright-base/playwright-plugin.js";
import { DEFAULT_CAPABILITIES } from "../core/plugin-api.js";

function makePlugin(launchError: string): PlaywrightPluginBase {
	class TestPlugin extends PlaywrightPluginBase {
		readonly name = "test-uninstalled";
		readonly capabilities = DEFAULT_CAPABILITIES;
		protected get userAgent(): string {
			return "test-agent";
		}
		protected get installHint(): string {
			return "Browser not installed. Run /web install to install it.";
		}
		protected async launchBrowser(): Promise<Browser> {
			throw new Error(launchError);
		}
	}
	return new TestPlugin();
}

describe("install-error tagging", () => {
	it("missing executable → failure result tagged errorKind=not-installed with the install hint", async () => {
		const result = await makePlugin(
			"Executable doesn't exist at /fake/ms-playwright/chromium-1",
		).navigate("https://example.com", "t1");

		expect(result.success).toBe(false);
		expect(result.error).toBe(
			"Browser not installed. Run /web install to install it.",
		);
		expect(result.errorKind).toBe("not-installed");
	});

	it("ordinary launch failure → untagged failure result with the raw error", async () => {
		const result = await makePlugin("connection refused").navigate(
			"https://example.com",
			"t1",
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("connection refused");
		expect(result.errorKind).toBeUndefined();
	});
});
