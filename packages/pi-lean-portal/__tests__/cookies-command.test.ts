/**
 * Tests for /web cookies import (importCookies in browser-cookies.ts) and
 * the handler-side keyword lowering (case-insensitive sub-command matching
 * against the kw local).
 *
 * Dispatcher-level casing pins (payload case survival, keyword lowering at
 * the /web dispatch step) live in browser-toggle.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("../core/router.js", () => ({
	getCookies: vi.fn(async () => ({ success: true, cookies: [] })),
	clearCookies: vi.fn(async () => ({ success: true })),
}));

// Mutable config-tier default so the none-vs-config-default precedence is
// testable (the real loadFullConfig serves a global cache). No cache exists
// behind the mock, so no invalidateConfigCache wiring is needed — provided
// for safety if a future teardown calls it.
const mockConfig = vi.hoisted(() => ({
	defaultProfile: "session",
	maxStorageStateSize: 10 * 1024 * 1024,
}));

vi.mock("../core/plugin-config.js", () => ({
	loadFullConfig: () => ({
		browser: mockConfig,
		plugins: { plugins: [], errors: [] },
	}),
	invalidateConfigCache: vi.fn(),
}));

// Wrap the two storage-state entry points the import flow uses so tests can
// queue one-shot overrides while every other export stays real.
vi.mock("../core/shared/storage-state.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../core/shared/storage-state.js")>();
	return {
		...actual,
		loadStorageState: vi.fn(
			(name: string) => actual.loadStorageState(name) as ReturnType<typeof actual.loadStorageState>,
		),
		probeStorageState: vi.fn(
			(name: string) => actual.probeStorageState(name) as ReturnType<typeof actual.probeStorageState>,
		),
		saveStorageState: vi.fn(
			(...args: Parameters<typeof actual.saveStorageState>) =>
				actual.saveStorageState(...args),
		),
	};
});

// `~/` expansion pin: point homedir() at the worker's temp dir (the parent
// of the isolated profile tree) so the test asserts against a known path.
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		homedir: () =>
			process.env.PI_PORTAL_PROFILE_DIR!.replace(/\/browser-state$/, ""),
	};
});

import browserToggle from "../browser-toggle.js";
import { handleCookiesSubcommand } from "../browser-cookies.js";
import {
	mockPi,
	mockCtx,
	captureWebHandler,
} from "./helpers/mock-pi.js";
import { uniqueName } from "./helpers/setup-temp-dir.js";
import { profileFilePath, probeStorageState, saveStorageState } from "../core/shared/storage-state.js";
import { pluginRegistry } from "../core/plugin-registry.js";
import { sessionManager } from "../core/shared/session-manager.js";
import { MockPlugin, makeConfig } from "./helpers/mock-plugin.js";

async function dispatch(args: string): Promise<ReturnType<typeof mockCtx>> {
	const { pi } = mockPi();
	browserToggle(pi);
	const ctx = mockCtx();
	await captureWebHandler(pi)(args, ctx);
	return ctx;
}

// ─── /web cookies import ─────────────────────────────────────────

// Worker temp dir (mocked homedir target): parent of the isolated profile tree.
const HOMEDIR = process.env.PI_PORTAL_PROFILE_DIR!.replace(/\/browser-state$/, "");

/** Last notify message dispatched to the mock UI. */
function lastNotify(ctx: ReturnType<typeof mockCtx>): string {
	const calls = ctx.ui.notify.mock.calls as unknown as Array<[string, string]>;
	return calls[calls.length - 1]?.[0] ?? "";
}

/** All notify messages. */
function allNotifies(ctx: ReturnType<typeof mockCtx>): string {
	return (ctx.ui.notify.mock.calls as unknown as Array<[string, string]>)
		.map((c) => c[0])
		.join("\n");
}

/** Write a cookies fixture into the worker temp dir, return its path. */
function writeFixture(content: string, name = uniqueName("cookies")): string {
	// The worker temp dir is not pre-created; the fixture's parent must exist.
	mkdirSync(HOMEDIR, { recursive: true });
	const p = join(HOMEDIR, name);
	writeFileSync(p, content);
	return p;
}

/** A minimal valid Netscape line (domain\tTRUE\t/\tTRUE\t<expires>\t<name>\t<value>). */
function nsLine(
	domain: string,
	name: string,
	value: string,
	opts: {
		sub?: boolean;
		secure?: boolean;
		expires?: number;
		path?: string;
		httpOnly?: boolean;
	} = {},
): string {
	const prefix = opts.httpOnly ? "#HttpOnly_" : "";
	return `${prefix}${domain}\t${opts.sub === false ? "FALSE" : "TRUE"}\t${opts.path ?? "/"}\t${opts.secure === false ? "FALSE" : "TRUE"}\t${opts.expires ?? 1999999999}\t${name}\t${value}`;
}

let pluginCounter = 0;

/** Register a mock plugin and create an active live session. */
function addLiveSession(
	profileName: string | undefined,
	taskKey = "browser-1",
): MockPlugin {
	const plugin = new MockPlugin(`mock-${++pluginCounter}`);
	pluginRegistry.register(plugin, makeConfig({ name: plugin.name }));
	const s = sessionManager.createSession(taskKey, plugin.name);
	s.currentUrl = "https://example.com/";
	if (profileName !== undefined) s.profileName = profileName;
	return plugin;
}

/** Read the saved storage-state.json for a profile. */
function readState(profileName: string): {
	cookies: Array<Record<string, unknown>>;
	origins: unknown[];
} {
	return JSON.parse(readFileSync(profileFilePath(profileName), "utf-8"));
}

/** Cookie lookup by name (assumes unique names in the fixture). */
function findCookie(
	state: ReturnType<typeof readState>,
	name: string,
): Record<string, unknown> | undefined {
	return state.cookies.find((c) => c.name === name);
}

describe("/web cookies import", () => {
	let plugin: MockPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		rmSync(process.env.PI_PORTAL_PROFILE_DIR!, { recursive: true, force: true });
		sessionManager.removeAll();
		pluginRegistry.clear();
		plugin = new MockPlugin("mock");
		pluginRegistry.register(plugin, makeConfig({ name: "mock" }));
		// Reset the mutable config tier — tests below mutate it.
		mockConfig.defaultProfile = "session";
	});

	afterEach(() => {
		sessionManager.removeAll();
		pluginRegistry.clear();
	});

	// ── I/O ──

	it("expands a leading ~/ against the mocked homedir", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		expect(p.startsWith(join(HOMEDIR, "cookies"))).toBe(true);
		const arg = `~/${p.slice(HOMEDIR.length + 1)}`;
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${arg}`, ctx, uniqueName("p"));
		// The import succeeded — the resolved path was the one read.
		expect(lastNotify(ctx)).toContain("Imported 1 cookie(s)");
	});

	it("resolves relative paths against ctx.cwd", async () => {
		writeFixture(`${nsLine("example.com", "sid", "v1")}\n`, "rel-cookies.txt");
		const ctx = mockCtx({ cwd: HOMEDIR });
		await handleCookiesSubcommand(
			"import rel-cookies.txt",
			ctx,
			uniqueName("p"),
		);
		expect(lastNotify(ctx)).toContain("Imported 1 cookie(s)");
	});

	it("refuses a file over the 10 MB import limit and writes nothing", async () => {
		const p = join(HOMEDIR, uniqueName("big"));
		writeFileSync(p, "#".repeat(11 * 1024 * 1024));
		const profile = uniqueName("p");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		expect(lastNotify(ctx)).toContain("import limit");
		expect(existsSync(profileFilePath(profile))).toBe(false);
	});

	it("refuses a missing file without writing", async () => {
		const profile = uniqueName("p");
		const ctx = mockCtx();
		await handleCookiesSubcommand(
			"import /tmp/does-not-exist-cookies.txt",
			ctx,
			profile,
		);
		expect(lastNotify(ctx)).toContain("Failed to read");
		expect(existsSync(profileFilePath(profile))).toBe(false);
	});

	it("refuses a non-regular file (e.g. a directory) without reading", async () => {
		const dir = join(HOMEDIR, uniqueName("dir"));
		mkdirSync(dir, { recursive: true });
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${dir}`, ctx, uniqueName("p"));
		expect(lastNotify(ctx)).toContain("not a regular file");
	});

	it("an empty remainder hits the usage warning and writes nothing", async () => {
		const ctx = mockCtx();
		await handleCookiesSubcommand("import", ctx, "p");
		expect(lastNotify(ctx)).toContain("Usage: /web cookies import <file>");
		expect(existsSync(profileFilePath("p"))).toBe(false);
	});

	it("keyword case is tolerated: 'IMPORT <path>' imports", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const profile = uniqueName("p");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`IMPORT ${p}`, ctx, profile);
		expect(lastNotify(ctx)).toContain("Imported 1 cookie(s)");
		expect(readState(profile).cookies).toHaveLength(1);
	});

	// ── Profile resolution ──

	it("a missing default-resolved named profile materializes at persist time", async () => {
		const profile = uniqueName("p");
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		expect(lastNotify(ctx)).toContain("Imported 1 cookie(s)");
		expect(existsSync(profileFilePath(profile))).toBe(true);
	});

	it("a session-profile target lazy-creates through saveStorageState", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, "session");
		expect(lastNotify(ctx)).toContain("'📋 session'");
		expect(existsSync(profileFilePath("_session-test-session-id"))).toBe(true);
	});

	it("a truthy-but-invalid session id refuses via the sessionProfileName guard", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx({
			sessionManager: { getSessionId: () => "bad id" },
		});
		await handleCookiesSubcommand(`import ${p}`, ctx, "session");
		expect(lastNotify(ctx)).toContain("Cannot resolve the session profile");
	});

	it("conversation default 'none' refuses instead of falling through to the config default", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		mockConfig.defaultProfile = uniqueName("cfg");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, "none");
		expect(lastNotify(ctx)).toContain("'none' (no persistence)");
		expect(existsSync(profileFilePath(mockConfig.defaultProfile))).toBe(false);
	});

	it("a none-mode live session (profileName unset) falls through to the none refusal", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		addLiveSession(undefined);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, "none");
		expect(lastNotify(ctx)).toContain("'none' (no persistence)");
	});

	it("a live session's profile outranks a differing conversation default, and a lastNav-restored session (no piSessionId) is still found", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const profile = uniqueName("shopping");
		// browser-1 = taskId(ctx) for "test-session-id"; no piSessionId recorded
		// (lastNav-restored sessions are created without one) but profileName set.
		const live = addLiveSession(profile);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, uniqueName("other"));
		expect(lastNotify(ctx)).toContain(`'${profile}'`);
		expect(lastNotify(ctx)).toContain("Synced 1 live session(s)");
		// The sync reached the live session.
		expect(live.calls.get("getCookies")).toBeDefined();
		expect(live.calls.get("addCookies")).toBeDefined();
	});

	// ── Parse / write behavior ──

	it("an unparseable file (zero importable cookies) aborts and writes nothing", async () => {
		const p = writeFixture("not a cookies file\nanother garbage line\n");
		const profile = uniqueName("p");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		expect(lastNotify(ctx)).toContain("No importable cookies");
		expect(lastNotify(ctx)).toContain("skipped 2 malformed line(s)");
		expect(existsSync(profileFilePath(profile))).toBe(false);
	});

	it("an all-expired file aborts and writes nothing", async () => {
		const p = writeFixture(`${nsLine("example.com", "sid", "v1", { expires: 1000 })}\n`);
		const profile = uniqueName("p");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		expect(lastNotify(ctx)).toContain("No importable cookies");
		expect(lastNotify(ctx)).toContain("1 expired");
		expect(existsSync(profileFilePath(profile))).toBe(false);
	});

	it("one skipped line still writes the valid cookies; the notify reads as success-with-warnings", async () => {
		const p = writeFixture(
			`${nsLine("example.com", "sid", "v1")}\nbroken line without tabs\n`,
		);
		const profile = uniqueName("p");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		const msg = lastNotify(ctx);
		expect(msg).toContain("Imported 1 cookie(s)");
		expect(msg).toContain("line 2: field-count");
		expect(readState(profile).cookies).toHaveLength(1);
	});

	it("written cookies carry the full StoredCookie shape (sameSite Lax, httpOnly false); pre-existing cookies and origins survive", async () => {
		const profile = uniqueName("p");
		saveStorageState(profile, {
			cookies: [
				{
					name: "pre", value: "old", domain: "other.com", path: "/",
					expires: 1999999999, httpOnly: true, secure: true,
					sameSite: "Strict",
				},
			],
			origins: [{ origin: "https://other.com", localStorage: [] }],
		});
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		const state = readState(profile);
		const sid = findCookie(state, "sid")!;
		expect(sid.sameSite).toBe("Lax");
		expect(sid.httpOnly).toBe(false);
		// Pre-existing cookie and origins survive the merge.
		expect(findCookie(state, "pre")).toMatchObject({ httpOnly: true, sameSite: "Strict" });
		expect(state.origins).toHaveLength(1);
	});

	it("importing the same file twice keeps one cookie per key (merge, not duplicate)", async () => {
		const profile = uniqueName("p");
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		const state = readState(profile);
		expect(state.cookies).toHaveLength(1);
		const keys = state.cookies.map((c) => `${c.name}|${c.domain}|${c.path}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("the notify never contains cookie names or values (counts only)", async () => {
		const p = writeFixture(
			`${nsLine("example.com", "secret-session-id-value", "super-secret-value")}\nbroken line\n`,
		);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, uniqueName("p"));
		const all = allNotifies(ctx);
		expect(all).not.toContain("secret-session-id-value");
		expect(all).not.toContain("super-secret-value");
	});

	// ── Security lift (disk path) ──
	// Semantics are pinned exhaustively in cookie-import.test.ts; the tests
	// here pin only the cross-layer composition the unit suite can't reach.

	it("a dot-differing import writes two cookies with the lift applied across the dot", async () => {
		const profile = uniqueName("p");
		saveStorageState(profile, {
			cookies: [
				{
					name: "sid", value: "old", domain: "example.com", path: "/",
					expires: 1999999999, httpOnly: true, secure: true, sameSite: "Strict",
				},
			],
			origins: [],
		});
		// Dotted line, marker-less — identity stays dot-aware (two cookies) but
		// the lift matches across the dot.
		const p = writeFixture(`${nsLine(".example.com", "sid", "new", { secure: false })}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		const state = readState(profile);
		expect(state.cookies).toHaveLength(2);
		const dotted = state.cookies.find((c) => c.domain === ".example.com")!;
		expect(dotted.name).toBe("sid");
		expect(dotted.value).toBe("new");
		expect(dotted.httpOnly).toBe(true);
		expect(dotted.secure).toBe(true);
		expect(dotted.sameSite).toBe("Strict");
	});

	it("a __Host- line with secure FALSE colliding with an existing secure __Host- cookie survives the post-lift gate; a fresh insecure one is rejected", async () => {
		const profile = uniqueName("p");
		saveStorageState(profile, {
			cookies: [
				{
					name: "__Host-a", value: "old", domain: "example.com", path: "/",
					expires: 1999999999, httpOnly: true, secure: true, sameSite: "Strict",
				},
			],
			origins: [],
		});
		const p = writeFixture(
			`${nsLine("example.com", "__Host-a", "new", { secure: false, sub: false })}\n` +
				`${nsLine("other.com", "__Secure-b", "x", { secure: false, sub: false })}\n`,
		);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		const state = readState(profile);
		const host = findCookie(state, "__Host-a")!;
		expect(host.value).toBe("new"); // repaired: lifted secure:true passed the gate
		expect(state.cookies.find((c) => c.name === "__Secure-b")).toBeUndefined();
		const msg = lastNotify(ctx);
		expect(msg).toContain("Imported 1 cookie(s)");
		expect(msg).toContain("__Host-/__Secure- prefix without Secure (the lift could not repair it)");
	});

	// ── Live-session sync ──

	it("a synced colliding cookie carries the file's value with the live cookie's security attributes", async () => {
		const profile = uniqueName("shopping");
		const live = addLiveSession(profile);
		live.cookieResult.cookies = [
			{
				name: "sid", value: "live-old", domain: "example.com", path: "/",
				expires: 1999999999, httpOnly: true, secure: true, sameSite: "None",
			},
		];
		// Marker-less import: the live jar must supply the lift.
		const p = writeFixture(`${nsLine("example.com", "sid", "file-new", { secure: false })}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, uniqueName("other"));
		const pushes = live.calls.get("addCookies") as unknown as Array<[
			string,
			Array<Record<string, unknown>>,
		]>;
		expect(pushes).toHaveLength(1);
		const pushed = pushes[0]![1].find((c) => c.name === "sid")!;
		// File-wins values, lifted security attributes.
		expect(pushed.value).toBe("file-new");
		expect(pushed.httpOnly).toBe(true);
		expect(pushed.secure).toBe(true);
		expect(pushed.sameSite).toBe("None");
		expect(lastNotify(ctx)).toContain("Imported values replaced 1 existing/live cookie(s)");
	});

	it("a collision present in two live jars and on disk counts once", async () => {
		const profile = uniqueName("shopping");
		for (const key of ["browser-1", "browser-2"]) {
			const live = addLiveSession(profile, key);
			live.cookieResult.cookies = [
				{
					name: "sid", value: "live-old", domain: "example.com", path: "/",
					expires: 1999999999, httpOnly: true, secure: true, sameSite: "None",
				},
			];
		}
		// The same incoming cookie is lifted against both jars and the disk
		// merge — the count must stay distinct-cookie, not per-lift.
		const p = writeFixture(`${nsLine("example.com", "sid", "file-new", { secure: false })}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, uniqueName("other"));
		expect(lastNotify(ctx)).toContain("replaced 1 existing/live cookie(s)");
	});

	it("a throwing addCookies aborts only that session; the second is still synced and the notify is a warning", async () => {
		const profile = uniqueName("shopping");
		const first = addLiveSession(profile);
		first.shouldThrow.add("addCookies");
		const second = addLiveSession(profile, "browser-2");
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, uniqueName("other"));
		expect(second.calls.get("addCookies")).toBeDefined();
		const msg = lastNotify(ctx);
		expect(msg).toContain("Synced 1 live session(s)");
		expect(msg).toContain("could not be synced");
	});

	it("addCookies fires before saveStorageState (sync-first ordering)", async () => {
		const profile = uniqueName("shopping");
		const live = addLiveSession(profile);
		const order: string[] = [];
		const origAdd = live.addCookies.bind(live);
		(live as unknown as { addCookies: unknown }).addCookies = async (
			...args: unknown[]
		) => {
			order.push("addCookies");
			return origAdd(
				...(args as unknown as Parameters<typeof live.addCookies>),
			);
		};
		vi.mocked(saveStorageState).mockImplementationOnce(() => {
			order.push("saveStorageState");
			return true;
		});
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		await handleCookiesSubcommand(
			`import ${p}`,
			mockCtx(),
			uniqueName("other"),
		);
		expect(order).toEqual(["addCookies", "saveStorageState"]);
	});

	it("a failed save after a successful sync notifies with the recovery framing", async () => {
		const profile = uniqueName("shopping");
		const live = addLiveSession(profile);
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		vi.mocked(saveStorageState).mockReturnValueOnce(false);
		await handleCookiesSubcommand(`import ${p}`, ctx, uniqueName("other"));
		expect(live.calls.get("addCookies")).toBeDefined();
		expect(lastNotify(ctx)).toContain("Failed to save imported cookies");
		expect(lastNotify(ctx)).toContain("hold the imported cookies");
	});

	it("a corrupt pre-existing storage-state.json refuses at the preflight — before any sync", async () => {
		const profile = uniqueName("p");
		mkdirSync(join(process.env.PI_PORTAL_PROFILE_DIR!, profile), { recursive: true });
		writeFileSync(profileFilePath(profile), "{not json");
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		expect(lastNotify(ctx)).toContain("unreadable");
		expect(plugin.calls.get("getCookies")).toBeUndefined();
		expect(plugin.calls.get("addCookies")).toBeUndefined();
	});

	it("a parseable-but-shape-invalid state file (cookies not an array) gets the same refusal", async () => {
		const profile = uniqueName("p");
		mkdirSync(join(process.env.PI_PORTAL_PROFILE_DIR!, profile), { recursive: true });
		writeFileSync(profileFilePath(profile), JSON.stringify({ cookies: "nope", origins: [] }));
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		expect(lastNotify(ctx)).toContain("unreadable");
	});

	it("state turning unreadable between preflight and persist refuses at step 4 (plain failure when nothing synced)", async () => {
		const profile = uniqueName("p");
		saveStorageState(profile, {
			cookies: [],
			origins: [],
		});
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		// Call 1 (preflight probe): ok. Call 2 (step-4 probe): corrupt.
		vi.mocked(probeStorageState)
			.mockReturnValueOnce("ok")
			.mockReturnValueOnce("corrupt");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, profile);
		const msg = lastNotify(ctx);
		expect(msg).toContain("turned unreadable");
		expect(msg).not.toContain("hold the imported cookies");
		expect(msg).toContain("Nothing was written");
		// Nothing written — the on-disk file still holds the empty state.
		expect(readState(profile).cookies).toHaveLength(0);
	});

	it("state turning unreadable at step 4 with a synced session uses the recoverable framing", async () => {
		const profile = uniqueName("shopping");
		saveStorageState(profile, { cookies: [], origins: [] });
		const live = addLiveSession(profile);
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		vi.mocked(probeStorageState)
			.mockReturnValueOnce("ok")
			.mockReturnValueOnce("corrupt");
		const ctx = mockCtx();
		await handleCookiesSubcommand(`import ${p}`, ctx, uniqueName("other"));
		expect(live.calls.get("addCookies")).toBeDefined();
		expect(lastNotify(ctx)).toContain("hold the imported cookies");
		// The sessions were mutated — "nothing was written" would be a lie.
		expect(lastNotify(ctx)).not.toContain("Nothing was written");
	});

	it("import honors the conversation default set via /web profile", async () => {
		const profile = uniqueName("p");
		await dispatch(`profile create ${profile}`);
		await dispatch(`profile ${profile}`);
		const p = writeFixture(`${nsLine("example.com", "sid", "v1")}\n`);
		const ctx = await dispatch(`cookies import ${p}`);
		expect(lastNotify(ctx)).toContain(`'${profile}'`);
		expect(existsSync(profileFilePath(profile))).toBe(true);
	});
});
