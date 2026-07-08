/**
 * Vitest globalSetup for pi-lean-host tests.
 *
 * Generates `generated/subdomains.ts` (or a stub if MiniWoB++ content
 * isn't available) so the static import in `register-suite.ts` always
 * resolves at module-load time. This prevents a MODULE_NOT_FOUND crash
 * on fresh clones before `npm run setup:miniwob` has been run.
 *
 * The host test files are excluded from `npm run test:ci`, so this
 * globalSetup only fires during full `npm test` runs.
 *
 * @module
 */

import { generateSubdomainsFile } from "./scripts/generate-subdomains.js";

export function setup(): void {
	generateSubdomainsFile();
}
