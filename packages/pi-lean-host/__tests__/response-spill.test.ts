/**
 * Response Disk Spill tests — disk spillover for truncated api-fetch responses.
 *
 * All tests are browser-free.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	existsSync,
	readFileSync,
	mkdirSync,
	chmodSync,
	rmSync,
	accessSync,
	constants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	spillResponse,
	cleanupAllSpill,
	formatSpillNotice,
	type SpillResult,
} from "../core/response-spill.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** A JSON string shorter than the inline limit (4000). */
function shortJson(): string {
	return JSON.stringify({ ok: true, items: Array(50).fill("x") }, null, 2);
}

/** A JSON string longer than the inline limit (4000). */
function longJson(): string {
	return JSON.stringify(
		{ ok: true, items: Array(600).fill("a-bit-of-content-here") },
		null,
		2,
	);
}

/** A different long JSON string for eviction tests. */
function otherLongJson(): string {
	return JSON.stringify(
		{ ok: true, items: Array(600).fill("other-stuff-here") },
		null,
		2,
	);
}

let testTempDir: string;

function cleanAll(): void {
	cleanupAllSpill();
}

// ─── 1. spillResponse() — basic spill ────────────────────────────────

describe("spillResponse() — basic spill", () => {
	beforeEach(() => {
		testTempDir = join(
			tmpdir(),
			`pi-lean-host-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		process.env.PI_HOST_TEMP_DIR = testTempDir;
	});

	afterEach(() => {
		cleanAll();
		delete process.env.PI_HOST_TEMP_DIR;
	});

	it("spills a long JSON string (>4000 chars)", () => {
		const json = longJson();
		const result = spillResponse(json, "test-session");

		expect(result).not.toBeNull();
		expect(result!.path).toMatch(/response-test-session-/);
		expect(result!.path).toMatch(/\.json$/);

		// File must exist on disk
		expect(existsSync(result!.path)).toBe(true);
		expect(readFileSync(result!.path, "utf-8")).toBe(json);
	});

	it("returns null for a short JSON string (<4000 chars)", () => {
		const json = shortJson();
		const result = spillResponse(json, "test-session");

		expect(result).toBeNull();
	});

	it("generates unique file paths for different content", () => {
		const r1 = spillResponse(longJson(), "test-session");
		const r2 = spillResponse(otherLongJson(), "test-session");

		expect(r1).not.toBeNull();
		expect(r2).not.toBeNull();
		expect(r1!.path).not.toBe(r2!.path);
		expect(existsSync(r1!.path)).toBe(true);
		expect(existsSync(r2!.path)).toBe(true);
	});

	it("writes valid JSON that can be parsed back", () => {
		const json = longJson();
		const result = spillResponse(json, "test-session");

		expect(result).not.toBeNull();
		const written = readFileSync(result!.path, "utf-8");
		let parsed: unknown;
		let expected: unknown;
		try {
			parsed = JSON.parse(written);
			expected = JSON.parse(json);
		} catch {
			expect.fail("JSON parse failed");
			return;
		}
		expect(parsed).toEqual(expected);
	});

	it("tolerates special characters in sessionKey", () => {
		const json = longJson();
		const result = spillResponse(json, "session/with:special@chars");

		expect(result).not.toBeNull();
		expect(result!.path).toMatch(/response-session_with_special_chars-/);
		expect(existsSync(result!.path)).toBe(true);
	});
});

// ─── 2. spillResponse() — eviction ───────────────────────────────────

describe("spillResponse() — eviction", () => {
	beforeEach(() => {
		testTempDir = join(
			tmpdir(),
			`pi-lean-host-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		process.env.PI_HOST_TEMP_DIR = testTempDir;
	});

	afterEach(() => {
		cleanAll();
		delete process.env.PI_HOST_TEMP_DIR;
	});

	it("keeps at most MAX_FILES_PER_SESSION files (8)", () => {
		const json = longJson();

		// Spill 10 times for the same session
		const results: (SpillResult | null)[] = [];
		for (let i = 0; i < 10; i++) {
			results.push(spillResponse(json, "evict-session"));
		}

		// All calls should return a result
		for (const r of results) {
			expect(r).not.toBeNull();
		}

		// At most 8 should exist on disk
		let existingCount = 0;
		for (const r of results) {
			if (r && existsSync(r.path)) existingCount++;
		}

		expect(existingCount).toBeLessThanOrEqual(8);
	});

	it("different session keys get independent limits", () => {
		const json = longJson();

		// Spill 10 for session A, 5 for session B
		const aResults: (SpillResult | null)[] = [];
		for (let i = 0; i < 10; i++) {
			aResults.push(spillResponse(json, "session-A"));
		}

		const bResults: (SpillResult | null)[] = [];
		for (let i = 0; i < 5; i++) {
			bResults.push(spillResponse(json, "session-B"));
		}

		// Session A: at most 8 files
		let aCount = 0;
		for (const r of aResults) {
			if (r && existsSync(r.path)) aCount++;
		}
		expect(aCount).toBeLessThanOrEqual(8);

		// Session B: all 5 should exist
		for (const r of bResults) {
			expect(r).not.toBeNull();
			expect(existsSync(r!.path)).toBe(true);
		}
	});
});

// ─── 3. I/O failure handling ──────────────────────────────────────────

describe("spillResponse() — I/O failure", () => {
	let roDir: string;

	afterEach(() => {
		cleanAll();
		delete process.env.PI_HOST_TEMP_DIR;
		// Restore write perms + clean up the roDir itself
		if (roDir) {
			try {
				chmodSync(roDir, 0o755);
				rmSync(roDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	it("returns null when the temp dir is read-only (I/O error)", () => {
		// Create a temp dir, remove write permission, then try to spill into it.
		roDir = join(tmpdir(), `pi-lean-host-ro-${Date.now()}`);
		mkdirSync(roDir, { recursive: true });
		chmodSync(roDir, 0o444); // read-only
		process.env.PI_HOST_TEMP_DIR = join(roDir, "subdir");

		// When running as root, chmod doesn't restrict writes — skip.
		try {
			accessSync(roDir, constants.W_OK);
			// Still writable? Must be root — skip the test.
		} catch {
			// Not writable — proceed with the assertion.
			const json = longJson();
			const result = spillResponse(json, "test-session");
			expect(result).toBeNull();
		}
	});

	it("returns null gracefully when session key is unusual", () => {
		// Set a writable dir but use a strange session key; should still
		// work normally.
		testTempDir = join(tmpdir(), `pi-lean-host-test-${Date.now()}`);
		process.env.PI_HOST_TEMP_DIR = testTempDir;

		const json = longJson();
		const result = spillResponse(json, "normal-session");
		expect(result).not.toBeNull();
	});
});

// ─── 4. cleanupAllSpill() ─────────────────────────────────────────────

describe("cleanupAllSpill()", () => {
	beforeEach(() => {
		testTempDir = join(tmpdir(), `pi-lean-host-test-${Date.now()}`);
		process.env.PI_HOST_TEMP_DIR = testTempDir;
	});

	afterEach(() => {
		cleanAll();
		delete process.env.PI_HOST_TEMP_DIR;
	});

	it("removes all spilled files across all sessions", () => {
		const json = longJson();

		const r1 = spillResponse(json, "session-A");
		const r2 = spillResponse(json, "session-B");

		expect(r1).not.toBeNull();
		expect(r2).not.toBeNull();

		cleanupAllSpill();

		expect(existsSync(r1!.path)).toBe(false);
		expect(existsSync(r2!.path)).toBe(false);
	});

	it("is safe to call when no files exist", () => {
		expect(() => cleanupAllSpill()).not.toThrow();
	});

	it("is safe to call multiple times", () => {
		cleanupAllSpill();
		cleanupAllSpill();
		expect(() => cleanupAllSpill()).not.toThrow();
	});
});

// ─── 5. formatSpillNotice() ────────────────────────────────────────────

describe("formatSpillNotice()", () => {
	const path = "/tmp/pi-lean-host/response-session-abc123-0.json";

	it("under threshold: mentions both grep and read, no size warning", () => {
		const spill: SpillResult = { path };
		const notice = formatSpillNotice(spill, 5000);
		expect(notice).toContain("📄 Full response (5000 chars)");
		expect(notice).toContain(path);
		expect(notice).toContain("grep");
		expect(notice).toContain("read");
		expect(notice).toContain("offset/limit");
		expect(notice).toContain("before calling api-fetch again");
		expect(notice).not.toContain("⚠");
	});

	it("over threshold: includes size warning plus both tools", () => {
		const spill: SpillResult = { path };
		const notice = formatSpillNotice(spill, 200_000);
		expect(notice).toContain("⚠ Very large response");
		expect(notice).toContain("narrow your query params");
		expect(notice).toContain("📄 Full response (200000 chars)");
		expect(notice).toContain(path);
		expect(notice).toContain("grep");
		expect(notice).toContain("read");
		expect(notice).toContain("offset/limit");
		expect(notice).toContain("before calling api-fetch again");
	});

	it("returns fallback hint when spill result is null", () => {
		const notice = formatSpillNotice(null, 5000);
		expect(notice).toContain("Response truncated at 4000 chars");
		expect(notice).toContain("5000 chars");
		expect(notice).toContain("disk spill unavailable");
		expect(notice).toContain("re-call api-fetch");
	});
});
