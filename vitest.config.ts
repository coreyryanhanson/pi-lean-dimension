import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globalSetup: ["packages/pi-lean-host/vitest.globalSetup.ts"],
		globals: true,
		include: ["packages/*/**/*.test.ts"],
		passWithNoTests: true,
		// Browser contract tests (Playwright subprocess, Firefox, Python bridges)
		// need extra headroom when running concurrently with other browser tests.
		// Unit tests finish in milliseconds and aren't affected.
		testTimeout: 15_000,
	},
});
