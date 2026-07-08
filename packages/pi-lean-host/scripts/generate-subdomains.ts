/**
 * Thin wrapper re-exporting the shared subdomain-file generator.
 *
 * This file exists so that `vitest.globalSetup.ts` can import a
 * TypeScript module. The actual generation logic lives in the shared
 * `.js` module to prevent drift with the `.mjs` setup script, which
 * cannot import `.ts` files directly.
 *
 * @module
 */

export { generateSubdomainsFile } from "./generate-subdomains-core.js";
