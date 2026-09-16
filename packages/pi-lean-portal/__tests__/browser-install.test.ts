/**
 * Structural tests for browser-install.ts (/web install) — no real browser.
 *
 * Covers:
 * - bundled-playwright resolution: success → spawn path; failure → generic
 *   manual command, no throw
 * - node-interpreter selection (bun-compiled pi vs npm-shim node; Windows .exe)
 * - shell-aware chromium detection + firefox marker detection (real fs on
 *   temp dirs; browsers.json content controlled via a mocked createRequire)
 * - form routing: direct form spawns in UI modes, prints in print mode;
 *   bare form prints the manual command outside TUI
 * - checklist dialog: pre-check, toggle, install-row confirm, empty guard,
 *   Esc cancel (driven through the captured ctx.ui.custom factory)
 * - spawn streaming: success notify, host-validation warning surfacing,
 *   spawn `error` event fallback
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	handleInstallSubcommand,
	pickBrowsersToInstall,
	detectInstalledBrowsers,
	resolveNodeInterpreter,
} from "../browser-install.js";

// ─── Module mocks ────────────────────────────────────────────────

// createRequire is wrapped so tests can stub what "playwright" resolves to
// (or make resolution throw); impl === null delegates to the real resolver.
const requireState = vi.hoisted(() => ({
	impl: null as null | ((id: string) => unknown),
}));

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: (from: string) => {
			if (requireState.impl) {
				const impl = requireState.impl;
				const fake = ((id: string) => impl(id)) as NodeRequire;
				fake.resolve = ((id: string) => impl(id)) as NodeRequire["resolve"];
				return fake;
			}
			return actual.createRequire(from);
		},
	};
});

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

beforeEach(() => {
	requireState.impl = null;
	spawnMock.mockReset();
});

afterAll(() => {
	requireState.impl = null;
});

// ─── Fixtures ────────────────────────────────────────────────────

function mockCtx(overrides: Record<string, unknown> = {}): any {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: vi.fn(),
			setWidget: vi.fn(),
			custom: vi.fn(),
		},
		...overrides,
	};
}

/** Stub the module resolution so browser-install sees a fake playwright. */
function stubPlaywrightResolution(
	corePackageJson?: string,
	execPaths?: { chromiumExec: string; firefoxExec: string },
) {
	const pw = execPaths
		? {
				chromium: { executablePath: () => execPaths.chromiumExec },
				firefox: { executablePath: () => execPaths.firefoxExec },
			}
		: { chromium: {}, firefox: {} };
	requireState.impl = (id: string) => {
		if (id === "playwright") return pw;
		if (id === "playwright/package.json")
			return "/fake/node_modules/playwright/package.json";
		if (corePackageJson && id === "playwright-core/package.json")
			return corePackageJson;
		throw new Error(`unmocked module id: ${id}`);
	};
}

function fakeChild() {
	const child = new EventEmitter() as any;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

/** pw mock whose executablePath reports the given path. */
function makePw(chromiumExec?: string, firefoxExec?: string): any {
	return {
		chromium: {
			executablePath: () => {
				if (chromiumExec === undefined) throw new Error("unknown browser");
				return chromiumExec;
			},
		},
		firefox: {
			executablePath: () => {
				if (firefoxExec === undefined) throw new Error("unknown browser");
				return firefoxExec;
			},
		},
	};
}

/**
 * Build a fake cache layout in a temp dir and point the mocked
 * playwright-core resolution at a browsers.json with the given entries.
 * Returns the executablePath values chromium/firefox should report.
 */
function fakeCacheLayout(
	browsers: Array<{ name: string; revision: number | string }>,
	{
		chromiumShellMarker = false,
		firefoxMarker = false,
	}: { chromiumShellMarker?: boolean; firefoxMarker?: boolean } = {},
): {
	chromiumExec: string;
	firefoxExec: string;
	corePackageJson: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "pw-install-test-"));
	const coreDir = join(root, "playwright-core");
	mkdirSync(coreDir, { recursive: true });
	writeFileSync(join(coreDir, "browsers.json"), JSON.stringify({ browsers }));

	const chromiumRev = 1243;
	const chromiumExec = join(
		root,
		"ms-playwright",
		`chromium-${chromiumRev}`,
		"chrome-linux64",
		"chrome",
	);
	if (chromiumShellMarker) {
		const shellDir = join(root, "ms-playwright", `chromium_headless_shell-4242`);
		mkdirSync(shellDir, { recursive: true });
		writeFileSync(join(shellDir, "INSTALLATION_COMPLETE"), "");
	}
	const firefoxRev = 1234;
	const firefoxExec = join(
		root,
		"ms-playwright",
		`firefox-${firefoxRev}`,
		"firefox",
		"firefox",
	);
	if (firefoxMarker) {
		mkdirSync(join(root, "ms-playwright", `firefox-${firefoxRev}`), {
			recursive: true,
		});
		writeFileSync(
			join(
				root,
				"ms-playwright",
				`firefox-${firefoxRev}`,
				"INSTALLATION_COMPLETE",
			),
			"",
		);
	}

	requireState.impl = (id: string) => {
		if (id === "playwright-core/package.json")
			return join(coreDir, "package.json");
		throw new Error(`unmocked module: ${id}`);
	};

	return {
		chromiumExec,
		firefoxExec,
		corePackageJson: join(coreDir, "package.json"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

// ==================================================================
//  Node interpreter selection
// ==================================================================

describe("resolveNodeInterpreter", () => {
	const realExecPath = process.execPath;

	function stubExecPath(value: string): () => void {
		Object.defineProperty(process, "execPath", { value, configurable: true });
		return () =>
			Object.defineProperty(process, "execPath", {
				value: realExecPath,
				configurable: true,
			});
	}

	it("returns process.execPath when it is a node binary (npm-shim install)", () => {
		expect(resolveNodeInterpreter()).toBe(realExecPath);
	});

	it("falls back to PATH `node` under a non-node runtime (bun-compiled pi)", () => {
		const restore = stubExecPath("/usr/local/bin/pi");
		try {
			expect(resolveNodeInterpreter()).toBe("node");
		} finally {
			restore();
		}
	});

	it("strips a .exe suffix so a Windows node.exe still selects the exact interpreter", () => {
		// Platform-independent exercise of the .exe strip via a POSIX path
		// (basename is platform-dependent, but the strip itself is not).
		const restore = stubExecPath("/usr/local/bin/node.exe");
		try {
			expect(resolveNodeInterpreter()).toBe("/usr/local/bin/node.exe");
		} finally {
			restore();
		}
	});
});

// ==================================================================
//  Detection
// ==================================================================

describe("detectInstalledBrowsers", () => {
	it("headless-shell marker present → chromium downloaded", () => {
		const layout = fakeCacheLayout(
			[
				{ name: "chromium", revision: 1243 },
				{ name: "chromium-headless-shell", revision: 4242 },
				{ name: "firefox", revision: 1234 },
			],
			{ chromiumShellMarker: true },
		);
		try {
			expect(
				detectInstalledBrowsers(makePw(layout.chromiumExec, layout.firefoxExec)),
			).toEqual({
				chromium: true,
				firefox: false,
			});
		} finally {
			layout.cleanup();
		}
	});

	it("full-chromium-only cache (--no-shell-style) → chromium missing, not downloaded", () => {
		const layout = fakeCacheLayout(
			[
				{ name: "chromium", revision: 1243 },
				{ name: "chromium-headless-shell", revision: 4242 },
				{ name: "firefox", revision: 1234 },
			],
			{ firefoxMarker: true },
		);
		try {
			expect(
				detectInstalledBrowsers(makePw(layout.chromiumExec, layout.firefoxExec)),
			).toEqual({
				chromium: false,
				firefox: true,
			});
		} finally {
			layout.cleanup();
		}
	});

	it("unparseable executable layout degrades to missing (safe direction)", () => {
		const layout = fakeCacheLayout(
			[{ name: "chromium-headless-shell", revision: 4242 }],
			{ chromiumShellMarker: true },
		);
		try {
			// No chromium-<rev> segment → regex never matches.
			expect(
				detectInstalledBrowsers(
					makePw("/opt/google/chrome/chrome", "/opt/firefox/firefox"),
				),
			).toEqual({
				chromium: false,
				firefox: false,
			});
		} finally {
			layout.cleanup();
		}
	});

	it("browsers.json read failure falls back to the chromium revision", () => {
		const root = mkdtempSync(join(tmpdir(), "pw-install-test-"));
		try {
			// Mocked resolution throws → fallback rev (1243) is used.
			requireState.impl = () => {
				throw new Error("resolution broken");
			};
			const shellDir = join(root, "chromium_headless_shell-1243");
			mkdirSync(shellDir, { recursive: true });
			writeFileSync(join(shellDir, "INSTALLATION_COMPLETE"), "");
			const exec = join(root, "chromium-1243", "chrome-linux64", "chrome");
			expect(detectInstalledBrowsers(makePw(exec)).chromium).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			requireState.impl = null;
		}
	});

	it("missing chromium-headless-shell entry falls back (never the string 'undefined')", () => {
		const root = mkdtempSync(join(tmpdir(), "pw-install-fb-"));
		try {
			// browsers.json lists only the full browser — no shell entry.
			const coreDir = join(root, "core");
			mkdirSync(coreDir, { recursive: true });
			writeFileSync(
				join(coreDir, "browsers.json"),
				JSON.stringify({ browsers: [{ name: "chromium", revision: 1243 }] }),
			);
			requireState.impl = (id: string) => {
				if (id === "playwright-core/package.json")
					return join(coreDir, "package.json");
				throw new Error(`unmocked module: ${id}`);
			};
			const msRoot = join(root, "ms-playwright");
			const exec = join(msRoot, "chromium-1243", "chrome-linux64", "chrome");
			// A stale marker at an unrelated revision must not satisfy the check.
			mkdirSync(join(msRoot, "chromium_headless_shell-4242"), { recursive: true });
			writeFileSync(
				join(msRoot, "chromium_headless_shell-4242", "INSTALLATION_COMPLETE"),
				"",
			);
			expect(detectInstalledBrowsers(makePw(exec)).chromium).toBe(false);
			// Marker at the chromium revision → the fallback resolves it.
			mkdirSync(join(msRoot, "chromium_headless_shell-1243"), { recursive: true });
			writeFileSync(
				join(msRoot, "chromium_headless_shell-1243", "INSTALLATION_COMPLETE"),
				"",
			);
			expect(detectInstalledBrowsers(makePw(exec)).chromium).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			requireState.impl = null;
		}
	});
});

// ==================================================================
//  Form routing (handler)
// ==================================================================

describe("handleInstallSubcommand — routing", () => {
	it("unknown engine name → usage warning, no spawn", async () => {
		const ctx = mockCtx();
		await handleInstallSubcommand("webkit", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Usage: /web install [chromium|firefox]"),
			"warning",
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("resolution failure → generic manual command, no throw, no spawn", async () => {
		requireState.impl = () => {
			throw new Error("ERR_MODULE_NOT_FOUND");
		};
		const ctx = mockCtx();
		await handleInstallSubcommand("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("npx playwright install chromium firefox"),
			"info",
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("direct form in print mode (no feedback channel) → manual command on stderr + notify, no spawn", async () => {
		stubPlaywrightResolution();
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const ctx = mockCtx({ mode: "print", hasUI: false });
			await handleInstallSubcommand("chromium", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining(
					`Install: ${process.execPath} /fake/node_modules/playwright/cli.js install chromium`,
				),
				"info",
			);
			// print mode's notify is a no-op stub — stderr is the real channel.
			expect(stderr).toHaveBeenCalledWith(
				expect.stringContaining("install chromium"),
			);
		} finally {
			stderr.mockRestore();
		}
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("bare form in RPC mode → manual command, no spawn (no dialog outside TUI)", async () => {
		stubPlaywrightResolution();
		const ctx = mockCtx({ mode: "rpc", hasUI: true });
		await handleInstallSubcommand("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining(
				`Install: ${process.execPath} /fake/node_modules/playwright/cli.js install chromium firefox`,
			),
			"info",
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("direct form in RPC mode spawns (feedback channel exists)", async () => {
		stubPlaywrightResolution();
		const child = fakeChild();
		spawnMock.mockImplementation(() => child);
		const ctx = mockCtx({ mode: "rpc", hasUI: true });
		const pending = handleInstallSubcommand("firefox", ctx);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		expect(spawnMock).toHaveBeenCalledWith(
			process.execPath,
			["/fake/node_modules/playwright/cli.js", "install", "firefox"],
			{ stdio: "pipe" },
		);
		child.emit("close", 0);
		await pending;
	});
});

// ==================================================================
//  Spawn & stream
// ==================================================================

describe("handleInstallSubcommand — spawn streaming", () => {
	it("success → completion notify; stdout tail reaches the progress widget", async () => {
		stubPlaywrightResolution();
		const child = fakeChild();
		spawnMock.mockImplementation(() => child);
		const ctx = mockCtx();
		const pending = handleInstallSubcommand("chromium", ctx);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		child.stdout.emit("data", Buffer.from("Downloading chromium 1243\n"));
		child.emit("close", 0);
		await pending;
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"install",
			expect.arrayContaining([
				expect.stringContaining("Downloading chromium 1243"),
			]),
		);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("install", undefined);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("✅ Installed: chromium"),
			"info",
		);
	});

	it("Playwright Host validation warning is surfaced in the completion notify", async () => {
		stubPlaywrightResolution();
		const child = fakeChild();
		spawnMock.mockImplementation(() => child);
		const ctx = mockCtx();
		const pending = handleInstallSubcommand("chromium", ctx);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		child.stderr.emit(
			"data",
			Buffer.from("Playwright Host validation warning: Missing dependencies.\n"),
		);
		child.emit("close", 0);
		await pending;
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("missing host dependencies"),
			"info",
		);
	});

	it("non-zero exit → manual-command fallback, no throw", async () => {
		stubPlaywrightResolution();
		const child = fakeChild();
		spawnMock.mockImplementation(() => child);
		const ctx = mockCtx();
		const pending = handleInstallSubcommand("chromium", ctx);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		child.emit("close", 1);
		await pending;
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Browser install failed (exit code 1)"),
			"warning",
		);
	});

	it("spawn error event (ENOENT etc.) → manual-command fallback, no hang", async () => {
		stubPlaywrightResolution();
		const child = fakeChild();
		spawnMock.mockImplementation(() => child);
		const ctx = mockCtx();
		const pending = handleInstallSubcommand("chromium", ctx);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		child.emit("error", new Error("spawn node ENOENT"));
		await pending;
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Browser install failed: spawn node ENOENT"),
			"warning",
		);
	});

	it("error followed by close settles once — single failure notify", async () => {
		// Node can fire both `error` and `close` for one failed spawn.
		stubPlaywrightResolution();
		const child = fakeChild();
		spawnMock.mockImplementation(() => child);
		const ctx = mockCtx();
		const pending = handleInstallSubcommand("chromium", ctx);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		child.emit("error", new Error("spawn node ENOENT"));
		child.emit("close", 1);
		await pending;
		const failures = ctx.ui.notify.mock.calls.filter((c: unknown[]) =>
			String(c[0]).includes("Browser install failed"),
		);
		expect(failures).toHaveLength(1);
	});
});

// ==================================================================
//  Bare form in TUI: dialog row states
// ==================================================================

describe("handleInstallSubcommand — dialog", () => {
	it("dialog resolution feeds the spawn: checked engines install", async () => {
		const layout = fakeCacheLayout(
			[
				{ name: "chromium", revision: 1243 },
				{ name: "chromium-headless-shell", revision: 4242 },
				{ name: "firefox", revision: 1234 },
			],
			{ firefoxMarker: true }, // firefox present → only chromium pre-checked
		);
		try {
			stubPlaywrightResolution(layout.corePackageJson, layout);
			const child = fakeChild();
			spawnMock.mockImplementation(() => child);
			const ctx = mockCtx({
				ui: {
					notify: vi.fn(),
					setWidget: vi.fn(),
					custom: vi.fn(async () => ["chromium"]),
				},
			});
			const pending = handleInstallSubcommand("", ctx);
			await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
			(spawnMock.mock.results[0]!.value as EventEmitter).emit("close", 0);
			await pending;
			expect(spawnMock).toHaveBeenCalledWith(
				process.execPath,
				["/fake/node_modules/playwright/cli.js", "install", "chromium"],
				{ stdio: "pipe" },
			);
		} finally {
			layout.cleanup();
		}
	});
});

// ==================================================================
//  pickBrowsersToInstall (driven through the ctx.ui.custom factory)
// ==================================================================

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function captureComponent(
	rows: Parameters<typeof pickBrowsersToInstall>[1],
	preChecked: string[],
) {
	let factory: any;
	const ctx = {
		mode: "tui",
		ui: {
			notify: vi.fn(),
			custom: vi.fn(async (f: any) => {
				factory = f;
				return new Promise<string[] | undefined>(() => {});
			}),
		},
	} as any;
	void pickBrowsersToInstall(ctx, rows, preChecked);
	let resolved: string[] | undefined;
	const component = factory(
		{ requestRender: vi.fn() },
		mockTheme,
		{},
		(v: string[] | undefined) => {
			resolved = v;
		},
	);
	return { component, resolved: () => resolved, notify: ctx.ui.notify };
}

describe("pickBrowsersToInstall", () => {
	const rows = [
		{ value: "chromium", label: "Chromium (~170 MB) — missing" },
		{ value: "firefox", label: "Firefox (~90 MB) — downloaded" },
	];

	it("pre-checked rows resolve unchanged via the Install row", async () => {
		const { component, resolved } = captureComponent(rows, ["chromium"]);
		component.handleInput("\x1b[B"); // down → firefox
		component.handleInput("\x1b[B"); // down → Install row
		component.handleInput("\r"); // Install
		await Promise.resolve();
		expect(resolved()).toEqual(["chromium"]);
	});

	it("Enter toggles a row; toggling before Install is picked up", async () => {
		const { component, resolved } = captureComponent(rows, []);
		component.handleInput("\r"); // toggle chromium on
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r"); // Install
		await Promise.resolve();
		expect(resolved()).toEqual(["chromium"]);
	});

	it("confirming with nothing checked notifies and stays open (guard)", async () => {
		const { component, resolved, notify } = captureComponent(rows, []);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r"); // Install with nothing checked
		await Promise.resolve();
		expect(resolved()).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Nothing selected"),
			"warning",
		);
	});

	it("Esc cancels (resolves undefined)", async () => {
		const { component, resolved } = captureComponent(rows, ["chromium"]);
		component.handleInput("\x1b");
		await Promise.resolve();
		expect(resolved()).toBeUndefined();
	});
});

// ==================================================================
//  /web dispatcher wiring
// ==================================================================

describe("/web install dispatcher wiring", () => {
	const REGISTRY_KEY = "__piToolMaskingRegistry";
	const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";
	const MODULE_STATE_KEY = "__piToolMaskingModuleState";

	const ALL_TOOLS = [
		{ name: "web-fetch", description: "fetch" },
		{ name: "browser-navigate", description: "navigate" },
		{ name: "web-learn", description: "learn" },
	];

	function mockPi(): any {
		const emitter = new EventEmitter();
		const active: any[] = [...ALL_TOOLS];
		return {
			getAllTools: vi.fn(() => ALL_TOOLS),
			getActiveTools: vi.fn(() => [...active]),
			setActiveTools: vi.fn((names: string[]) => {
				active.length = 0;
				active.push(...names);
			}),
			appendEntry: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn(),
			get events() {
				return {
					emit: (channel: string, data: unknown) => emitter.emit(channel, data),
					on: (channel: string, handler: (data: unknown) => void) => {
						emitter.on(channel, handler);
						return () => emitter.off(channel, handler);
					},
				};
			},
		};
	}

	function captureWebHandler(
		pi: any,
	): (args: string, ctx: any) => Promise<void> {
		return (pi.registerCommand as Mock).mock.calls[0]![1].handler;
	}

	beforeEach(() => {
		delete (globalThis as any)[REGISTRY_KEY];
		delete (globalThis as any)[RESTORE_EVENT_KEY];
		delete (globalThis as any)[MODULE_STATE_KEY];
	});

	it("'/web install chromium' routes the engine to the install handler", async () => {
		vi.doMock("../browser-install.js", () => ({
			handleInstallSubcommand: vi.fn(async () => {}),
		}));
		const mod = await import("../browser-toggle.js");
		const pi = mockPi();
		mod.default(pi);
		const ctx = mockCtx();
		await captureWebHandler(pi)("install chromium", ctx);
		const { handleInstallSubcommand } = await import("../browser-install.js");
		expect(handleInstallSubcommand).toHaveBeenCalledWith("chromium", ctx);
		vi.doUnmock("../browser-install.js");
		vi.resetModules();
	});

	it("bare '/web install' routes an empty sub", async () => {
		vi.doMock("../browser-install.js", () => ({
			handleInstallSubcommand: vi.fn(async () => {}),
		}));
		const mod = await import("../browser-toggle.js");
		const pi = mockPi();
		mod.default(pi);
		const ctx = mockCtx();
		await captureWebHandler(pi)("install", ctx);
		const { handleInstallSubcommand } = await import("../browser-install.js");
		expect(handleInstallSubcommand).toHaveBeenCalledWith("", ctx);
		vi.doUnmock("../browser-install.js");
		vi.resetModules();
	});

	it("usage line advertises the install subcommand", () => {
		const pi = mockPi();
		// Re-import: browser-toggle must be re-importable after resetModules.
		return import("../browser-toggle.js").then((mod) => {
			mod.default(pi);
			const [name, opts] = (pi.registerCommand as Mock).mock.calls[0]!;
			expect(name).toBe("web");
			expect(opts.description).toContain("install");
		});
	});
});
