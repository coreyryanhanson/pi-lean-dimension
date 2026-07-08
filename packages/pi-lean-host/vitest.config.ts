import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globalSetup: ["./vitest.globalSetup.ts"],
		globals: true,
		include: ["**/*.test.ts"],
		passWithNoTests: true,
		testTimeout: 15_000,
	},
});
