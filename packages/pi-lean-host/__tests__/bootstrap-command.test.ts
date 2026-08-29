/**
 * `/api bootstrap oauth <domain> <spec>` — the inject-and-exit orchestration
 * command of the agent-driven OAuth2 bootstrap (Phase 2.8). Mocked pi +
 * ctx, mirroring __tests__/api-toggle.test.ts idioms. Covers the locked test
 * strategy: exact sendUserMessage args (deliverAs "followUp", brief contains
 * domain + spec + tool name + stop-and-ask line); learn auto-enable when off
 * (+ notify fires only when actually flipped); loud focus-guard fail; usage
 * errors for bare/unknown mode and missing domain/spec (F2); headless
 * refusal (H1 command side).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setDefaultResolutionMode } from "pi-tool-masking";
import {
	setSecretsDir,
	getSecretsDir,
	writeSecret,
} from "../core/secrets-store.js";
import initApiToggle, { _resetToggleStateForTest } from "../core/api-toggle.js";

// Clean globalThis registry between test files (same as api-toggle.test.ts).
const REGISTRY_KEY = "__piToolMaskingRegistry";
const RESTORE_EVENT_KEY = "__piToolMaskingLastRestoreEvent";
const MODULE_STATE_KEY = "__piToolMaskingModuleState";

let tmpSecrets = "";
let savedSecretsDir = "";

beforeEach(() => {
	_resetToggleStateForTest();
	delete (globalThis as any)[REGISTRY_KEY];
	delete (globalThis as any)[RESTORE_EVENT_KEY];
	delete (globalThis as any)[MODULE_STATE_KEY];
	// Point the secrets store at a temp dir so the provisioned-secrets brief
	// injection never reads the developer's real store.
	savedSecretsDir = getSecretsDir();
	tmpSecrets = mkdtempSync(join(tmpdir(), "host-bootstrap-secrets-"));
	setSecretsDir(tmpSecrets);
});

afterEach(() => {
	rmSync(tmpSecrets, { recursive: true, force: true });
	setSecretsDir(savedSecretsDir);
});

// ─── Fixtures ────────────────────────────────────────────────────

const ALL_TOOLS = [
	{ name: "api-guide", description: "API guide" },
	{ name: "api-fetch", description: "API fetch" },
	{ name: "api-learn", description: "API learn" },
	{ name: "api-probe", description: "API probe" },
	{ name: "api-scaffold", description: "API scaffold" },
	{ name: "oauth-mint", description: "OAuth mint" },
	{ name: "read", description: "read files" },
	{ name: "bash", description: "shell" },
];

function mockPi(initialTools?: string[]): {
	pi: ExtensionAPI;
	sendUserMessage: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
} {
	let active = initialTools ?? ALL_TOOLS.map((t) => t.name);
	const sendUserMessage = vi.fn();
	const setActiveTools = vi.fn((names: string[]) => {
		active = [...names];
	});
	const pi = {
		getAllTools: vi.fn(() => ALL_TOOLS as any),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools,
		appendEntry: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(),
		sendUserMessage,
		get events() {
			const emitter = new EventEmitter();
			return {
				emit: (channel: string, data: unknown) => emitter.emit(channel, data),
				on: (channel: string, handler: (data: unknown) => void) => {
					emitter.on(channel, handler);
					return () => emitter.off(channel, handler);
				},
			};
		},
	} as unknown as ExtensionAPI;
	return { pi, sendUserMessage, setActiveTools };
}

function mockCtx(overrides: Partial<ExtensionContext> = {}): any {
	return {
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus: vi.fn(),
			theme: { fg: (_c: string, t: string) => t },
			notify: vi.fn(),
		},
		mode: "tui",
		cwd: "/mock",
		hasUI: true,
		isIdle: () => true,
		...overrides,
	};
}

function captureApiHandler(pi: ExtensionAPI) {
	return (pi.registerCommand as any).mock.calls[0][1].handler as (
		args: string,
		ctx: any,
	) => Promise<void>;
}

async function runBootstrap(
	args: string,
	initialTools?: string[],
	ctxOverrides?: Record<string, unknown>,
) {
	const { pi, sendUserMessage, setActiveTools } = mockPi(initialTools);
	initApiToggle(pi);
	const ctx = mockCtx(ctxOverrides);
	await captureApiHandler(pi)(`bootstrap ${args}`, ctx);
	return { pi, ctx, sendUserMessage, setActiveTools };
}

const out = (ctx: any) =>
	(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
		.map((c) => String(c[0]))
		.join("\n");

// ==================================================================
// Usage / argument validation (F2, F4)
// ==================================================================

describe("bootstrap — usage errors", () => {
	it("bare /api bootstrap prints usage listing the mode, no injection", async () => {
		const { ctx, sendUserMessage } = await runBootstrap("");
		expect(out.call(null, ctx)).toContain("Available modes: oauth");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("unknown mode → usage error listing available modes", async () => {
		const { ctx, sendUserMessage } = await runBootstrap("recipes x y");
		expect(out.call(null, ctx)).toContain('Unknown bootstrap mode: "recipes"');
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("missing spec → usage error (F2: both required)", async () => {
		const { ctx, sendUserMessage } = await runBootstrap("oauth api.example.org");
		expect(out.call(null, ctx)).toContain("both required, domain first");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("missing domain → usage error (F2: domain first, required)", async () => {
		const { ctx, sendUserMessage } = await runBootstrap("oauth");
		expect(out.call(null, ctx)).toContain(
			"Usage: /api bootstrap oauth <domain> <spec>",
		);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});

// ==================================================================
// Headless refusal (H1, command side)
// ==================================================================

describe("bootstrap — headless refusal", () => {
	it("refuses to inject when !ctx.hasUI", async () => {
		const { ctx, sendUserMessage } = await runBootstrap(
			"oauth osm.invalid https://docs.example",
			[], // learn off — headless check fires before the learn flip too
			{ hasUI: false },
		);
		expect(out.call(null, ctx)).toContain("requires an interactive session");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});

// ==================================================================
// Happy path — exact sendUserMessage args
// ==================================================================

describe("bootstrap — inject-and-exit", () => {
	it("injects the brief with deliverAs followUp, containing domain + spec + tool name + stop-and-ask line", async () => {
		const { ctx, sendUserMessage } = await runBootstrap(
			"oauth example.org https://docs.example.org/oauth",
		);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const [brief, opts] = (sendUserMessage as ReturnType<typeof vi.fn>).mock
			.calls[0]!;
		expect(opts).toEqual({ deliverAs: "followUp" });
		const text = String(brief);
		expect(text).toContain("example.org");
		expect(text).toContain("https://docs.example.org/oauth");
		expect(text).toContain("`oauth-mint`");
		expect(text).toContain("stop and ask");
		expect(text).toContain("/api secrets example.org <name>");
		// Empty store → no provisioned-secrets note.
		expect(text).not.toContain("Provisioned secret names");
		// No learn flip → no flip notify.
		expect(out.call(null, ctx)).not.toContain("Learn mode enabled");
	});

	it("injects provisioned secret NAMES (never values) into the brief, parent-domain normalized", async () => {
		writeSecret("example.org", "app_id", "real-id-value");
		writeSecret("example.org", "app_secret", "hunter2");
		const { sendUserMessage } = await runBootstrap(
			"oauth api.example.org https://docs.example.org/oauth",
		);
		const text = String(
			(sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0],
		);
		expect(text).toContain("Provisioned secret names for this domain");
		expect(text).toContain("`app_id`");
		expect(text).toContain("`app_secret`");
		// Values never enter the transcript.
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("real-id-value");
	});

	it("auto-enables learn when off, notifies the flip only then, and still injects", async () => {
		const { ctx, sendUserMessage, setActiveTools } = await runBootstrap(
			"oauth osm.invalid https://docs.example",
			[], // learn off
		);
		expect(out.call(null, ctx)).toContain("Learn mode enabled");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		// enableLearn cascades api on — the masking library receives the new
		// active-tool set including every learn-tool name.
		const enabled = (setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(
			-1,
		)![0] as string[];
		expect(enabled).toEqual(expect.arrayContaining(["api-learn", "oauth-mint"]));
	});

	it("focus-mode holding + learn off → loud fail, no injection, no toolset write", async () => {
		const { pi, sendUserMessage, setActiveTools } = mockPi([]);
		setDefaultResolutionMode(pi, "inclusion");
		initApiToggle(pi);
		const ctx = mockCtx();
		await captureApiHandler(pi)("bootstrap oauth osm.invalid https://docs", ctx);
		expect(out.call(null, ctx)).toContain("inclusion mode");
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(setActiveTools).not.toHaveBeenCalled();
	});

	it("focus-mode holding + learn already on → proceeds (flip is the only guarded actuation)", async () => {
		const { pi, sendUserMessage, setActiveTools } = mockPi(); // learn on
		setDefaultResolutionMode(pi, "inclusion");
		initApiToggle(pi);
		const ctx = mockCtx();
		await captureApiHandler(pi)("bootstrap oauth osm.invalid https://docs", ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(setActiveTools).not.toHaveBeenCalled();
	});
});
