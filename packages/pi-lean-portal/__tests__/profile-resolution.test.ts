/**
 * Direct unit tests for resolveNavigateProfile (core/profile-resolution.ts).
 * The function is pure over its arguments plus the on-disk profile tree, so
 * these run against the PI_PORTAL_PROFILE_DIR temp dir from setup-temp-dir.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	profileDir,
	sessionProfileName,
} from "../core/shared/storage-state.js";
import { resolveNavigateProfile } from "../core/profile-resolution.js";
import { uniqueName } from "./helpers/setup-temp-dir.js";

const PI_SESSION = "test-session-1234";

/** Narrow a resolution to its refusal branch (throws on success). */
function refusalOf(r: ReturnType<typeof resolveNavigateProfile>) {
	if (!("refusal" in r)) throw new Error(`expected refusal, got ${JSON.stringify(r)}`);
	return r.refusal;
}

describe("resolveNavigateProfile", () => {
	const created: string[] = [];

	afterEach(() => {
		for (const name of created) rmSync(profileDir(name), { recursive: true, force: true });
		created.length = 0;
	});

	it("resolves 'none' and undefined to no profile", () => {
		expect(resolveNavigateProfile("none", "agent", PI_SESSION)).toEqual({});
		expect(resolveNavigateProfile(undefined, "conversation", PI_SESSION)).toEqual({});
	});

	it("resolves 'session' to the conversation's own _session-* name", () => {
		const r = resolveNavigateProfile("session", "agent", PI_SESSION);
		expect(r).toEqual({ profileName: sessionProfileName(PI_SESSION) });
	});

	it("accepts the conversation's own _session-* name even when the dir is missing", () => {
		const own = sessionProfileName(PI_SESSION);
		const r = resolveNavigateProfile(own, "agent", PI_SESSION);
		expect(r).toEqual({ profileName: own });
	});

	it("refuses a foreign _session-* name without creating a directory", () => {
		const r = resolveNavigateProfile("_session-someone-else", "agent", PI_SESSION);
		expect(refusalOf(r).error).toContain("managed internally");
		expect(existsSync(profileDir("_session-someone-else"))).toBe(false);
	});

	it("resolves an existing named profile without touching the dir", () => {
		const name = uniqueName("existing");
		mkdirSync(profileDir(name), { recursive: true });
		created.push(name);
		const r = resolveNavigateProfile(name, "agent", PI_SESSION);
		expect(r).toEqual({ profileName: name });
	});
});
