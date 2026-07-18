import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["packages/pi-lean-portal/__tests__/helpers/setup-temp-dir.ts"],
		include: ["packages/*/**/*.test.ts", "bench/**/*.test.ts"],
		passWithNoTests: true,
		// Browser contract tests (Playwright subprocess, Firefox, Python bridges)
		// need extra headroom when running concurrently with other browser tests.
		// Unit tests finish in milliseconds and aren't affected.
		testTimeout: 15_000,
	},
});
