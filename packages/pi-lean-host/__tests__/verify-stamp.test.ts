/**
 * /api verify stamp-routine tests — the `verified:` line edit is isolated to
 * the frontmatter block (a `verified:` string in prose is never matched),
 * the absent field is inserted before the closing `---`, an existing line is
 * replaced in place regardless of format, and comments + key order are
 * preserved (no YAML round-trip). `--force` stamps without any HTTP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../core/transport.js", async () => ({
	...(await vi.importActual<typeof import("../core/transport.js")>(
		"../core/transport.js",
	)),
	fetchUrl: vi.fn(),
}));

import { fetchUrl } from "../core/transport.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import { handleVerifySubcommand } from "../core/verify-command.js";
import { TODAY } from "../core/parse-api-guide.js";

let tmpGuidesDir: string;

/** A valid recipe for verify.test; `verifiedLine` controls the stamp field. */
function recipe(verifiedLine?: string, body = "prose body"): string {
	const fields = [
		`---`,
		`kind: api`,
		`# comment that must survive the stamp`,
		`domains: [verify.test]`,
		`icon: ✅`,
		`shortName: Verify`,
		`apiHost: https://verify.test`,
		...(verifiedLine === undefined ? [] : [verifiedLine]),
		`# comment before auth`,
		`auth:`,
		`  kind: none`,
		`responseShape:`,
		`  format: json`,
		`  charset: utf-8`,
		`operations:`,
		`  - name: get`,
		`    via: restGet`,
		`    path: /x`,
		`    accept: json`,
		`---`,
		body,
	];
	return fields.join("\n") + "\n";
}

beforeEach(() => {
	tmpGuidesDir = mkdtempSync(join(tmpdir(), "host-verify-stamp-"));
	setUserGuidesDir(tmpGuidesDir);
	invalidateCache();
});

afterEach(() => {
	rmSync(tmpGuidesDir, { recursive: true, force: true });
});

function setupGuide(raw: string): void {
	const dir = join(tmpGuidesDir, "verify.test");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "guide.md"), raw, "utf-8");
	invalidateCache();
}

function readGuide(): string {
	return readFileSync(join(tmpGuidesDir, "verify.test", "guide.md"), "utf-8");
}

function mockCtx(): any {
	return { ui: { notify: vi.fn() }, hasUI: true };
}

describe("/api verify stamp routine", () => {
	it("--force stamps verified: today without any HTTP", async () => {
		setupGuide(recipe("verified: 2026-07-17"));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test --force", ctx);

		expect(vi.mocked(fetchUrl)).not.toHaveBeenCalled();
		expect(readGuide()).toContain(`verified: ${TODAY()}`);
	});

	it("stamps only the verified: line in the frontmatter, never a verified: string in prose", async () => {
		const body = "Prose mentions verified: 2026-07-16 for historical reference.";
		setupGuide(recipe("verified: 2026-07-17", body));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test --force", ctx);

		const stamped = readGuide();
		// Frontmatter line replaced with today; prose string untouched.
		expect(stamped).toContain(`verified: ${TODAY()}`);
		expect(stamped).toContain("Prose mentions verified: 2026-07-16");
	});

	it("inserts an absent verified field as the last frontmatter entry before the closing ---", async () => {
		setupGuide(recipe(undefined));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test --force", ctx);

		const stamped = readGuide();
		// The verified line lands immediately before the closing ---.
		expect(stamped).toContain(`verified: ${TODAY()}\n---`);
	});

	it("replaces an existing verified line in place regardless of value format", async () => {
		// Quoted value proves the stamp matches the key, not a date pattern.
		setupGuide(recipe('verified: "2026-07-17"'));
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test --force", ctx);

		const stamped = readGuide();
		expect(stamped).toContain(`verified: ${TODAY()}`);
		expect(stamped).not.toContain('verified: "2026-07-17"');
	});

	it("preserves comments and key ordering (no YAML round-trip)", async () => {
		setupGuide(recipe("verified: 2026-07-17"));
		const before = readGuide();
		const ctx = mockCtx();
		await handleVerifySubcommand("verify.test --force", ctx);
		const after = readGuide();

		expect(after).toContain("# comment that must survive the stamp");
		expect(after).toContain("# comment before auth");
		// Key order unchanged: kind, domains, icon, shortName, apiHost, verified, auth, …
		const orderOf = (s: string) =>
			s
				.split("\n")
				.map((l) => /^(\w+):/.exec(l)?.[1])
				.filter((k): k is string => !!k);
		expect(orderOf(after)).toEqual(orderOf(before));
		const changed = after.split("\n").length - before.split("\n").length;
		expect(changed).toBe(0); // in-place replacement, no added/removed lines
		expect(after).not.toContain("2026-07-17"); // old date gone
	});
});
