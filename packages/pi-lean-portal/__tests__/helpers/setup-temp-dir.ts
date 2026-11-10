/**
 * Test setup: isolate each worker's temp directory using process.pid.
 *
 * vitest's default `forks` pool runs each test file in a separate Node
 * process with a unique PID.  Keying PI_BROWSER_TEMP_DIR on the PID
 * gives each worker a disjoint filesystem namespace, preventing
 * cross-worker `removeAllSnapshotFiles()` races that cause flaky
 * ENOENT / null-result failures in snapshot-cache.test.ts.
 *
 * This file must be listed in vitest's `setupFiles` so it runs *before*
 * any test file import, including the module-level `const BROWSER_TEMP_DIR`
 * evaluation in `core/shared/paths.ts`.
 */
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

const dir = `${tmpdir()}/pi-lean-portal-test-${process.pid}`;
process.env.PI_BROWSER_TEMP_DIR = dir;
// Profile-state tests create/remove real profile dirs; keep them off the
// user's actual ~/.pi/agent/pi-lean-portal/browser-state tree.
process.env.PI_PORTAL_PROFILE_DIR = `${dir}/browser-state`;

// Repo-wide test env hygiene (this is the shared vitest setupFiles entry):
// a pi host that started this process as a deferred child sets
// PI_TOOLMASKING_DEFER to its own pid, which makes every pi-tool-masking
// toggle a silent no-op. Test workers are not deferring children — clear it
// so toggle paths in every package actually actuate.
delete process.env.PI_TOOLMASKING_DEFER;

/**
 * Make a unique profile name for each test to avoid cross-test
 * filesystem contamination.
 */
export function uniqueName(base: string): string {
	return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

process.on("exit", () => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});
