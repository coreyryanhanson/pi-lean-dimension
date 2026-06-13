import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true, // allow describe/it without imports
		include: ["__tests__/**/*.test.ts", "core/archived/**/*.test.ts"],
	},
});
