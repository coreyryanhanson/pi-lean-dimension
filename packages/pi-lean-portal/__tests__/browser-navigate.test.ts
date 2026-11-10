/**
 * browser-navigate tool tests — notify path when browser isn't installed,
 * profile-resolution passthrough to the router, and profile-refusal rendering.
 *
 * The router is mocked; tests assert the navigate options the tool forwards.
 */

import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
} from "vitest";
import { browserNavigateTool } from "../tools/browser-navigate.js";
import { getConversationDefaultProfile } from "../browser-toggle.js";
import { formatProfileRefusal } from "../core/profile-resolution.js";

// ─── Mock router ─────────────────────────────────────────────────

const mockNavigateResult = {
	success: false,
	url: "https://example.com/",
	title: "",
	snapshot: "",
	elementCount: 0,
	error: "Browser not installed. Run /web install to install it.",
	errorKind: "not-installed",
	backendUsed: "chromium",
};

vi.mock("../core/router.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/router.js")>();
	return {
		...actual,
		navigate: vi.fn(async () => mockNavigateResult),
		captureScreenshotLine: vi.fn(async () => ""),
	};
});

// ─── Mock utils — quiet the updateFooterStatus call ──────────────

vi.mock("../tools/utils.js", () => ({
	updateFooterStatus: vi.fn(),
	profileLine: vi.fn(() => ""),
	contentText: (
		result: { content?: Array<{ type: string; text?: string }> } | undefined,
		fallback = "",
	) => (result?.content?.[0]?.type === "text" ? result.content[0].text : fallback),
	renderExpandedText: vi.fn((_base: string, _theme: unknown, content: string) => content),
}));

// ─── Mock browser-toggle for getConversationDefaultProfile ──────

vi.mock("../browser-toggle.js", () => ({
	getConversationDefaultProfile: vi.fn(() => undefined),
}));

// ─── Mock session-manager ───────────────────────────────────────

vi.mock("../core/shared/session-manager.js", () => ({
	sessionManager: {
		removeSession: vi.fn(),
		createSession: vi.fn(),
		getSession: vi.fn(() => ({
			currentUrl: "",
			currentTitle: "",
			persistState: false,
		})),
		updateSession: vi.fn(),
		getStatus: vi.fn(() => "idle"),
		setLastNav: vi.fn(),
		getLastNav: vi.fn(() => null),
		getSessionId: vi.fn(() => "test-session"),
	},
}));

// ─── Mock snapshot-cache ────────────────────────────────────────

vi.mock("../core/shared/snapshot-cache.js", () => ({
	removeSnapshotFiles: vi.fn(),
}));

// ─── Mock guides ─────────────────────────────────────────────────

vi.mock("../core/guides.js", () => ({
	resolveApplicableGuides: vi.fn(() => []),
	formatGuideFooter: vi.fn(() => ""),
}));

// ─── Tests ──────────────────────────────────────────────────────

describe("browser-navigate notify path", () => {
	let notifySpy: ReturnType<typeof vi.fn>;
	let mockCtx: Record<string, unknown>;

	beforeEach(() => {
		notifySpy = vi.fn();
		mockCtx = {
			sessionManager: {
				getSessionId: vi.fn(() => "test-session"),
			},
			ui: {
				notify: notifySpy,
				setStatus: vi.fn(),
				theme: {
					fg: vi.fn((_c: string, t: string) => t),
				},
			},
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("emits ctx.ui.notify when browser is not installed", async () => {
		const result = await browserNavigateTool.execute(
			"call-1",
			{ url: "https://example.com/" },
			undefined,
			undefined,
			mockCtx as any,
		);

		// Tool should return an error result
		expect(result.details).toBeDefined();
		expect((result.details as Record<string, unknown>).error).toBe(true);

		// notify should have been called with the install command
		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith(
			"Browser not installed. Run /web install to install it.",
			"warning",
		);
	});

	it.each([
		{
			label: "generic failure",
			error: "Navigation timeout: page did not load within 30 seconds",
			backendUsed: "chromium",
		},
		{
			// Python backends produce "not installed" errors carrying their own
			// pip hint; they never set errorKind, so the notify must stay silent.
			label: "install-shaped error text without an errorKind tag",
			error:
				"ERROR: Playwright chromium is not installed.\n  pip install playwright",
			backendUsed: "chromium-py",
		},
	])(
		"does not emit notify for $label",
		async ({ error, backendUsed }) => {
			const { navigate } = await import("../core/router.js");
			(navigate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				success: false,
				url: "https://example.com/",
				title: "",
				snapshot: "",
				elementCount: 0,
				error,
				backendUsed,
			});

			await browserNavigateTool.execute(
				"call-2",
				{ url: "https://example.com/" },
				undefined,
				undefined,
				mockCtx as any,
			);

			// notify should NOT have been called
			expect(notifySpy).not.toHaveBeenCalled();
		},
	);
});

// ─── Profile-resolution passthrough ───────────────────────────

const CONV_PROFILE = "navtest-prof";

describe("profile-resolution passthrough", () => {
	let navigate: ReturnType<typeof vi.fn>;
	let mockCtx: Record<string, unknown>;

	beforeEach(async () => {
		navigate = (await import("../core/router.js")).navigate as ReturnType<typeof vi.fn>;
		mockCtx = {
			sessionManager: { getSessionId: vi.fn(() => "test-session") },
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				theme: { fg: vi.fn((_c: string, t: string) => t) },
			},
		};
		vi.mocked(getConversationDefaultProfile).mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		["an explicit param over the conversation default", CONV_PROFILE, CONV_PROFILE, "profile"],
		["a named conversation default", undefined, CONV_PROFILE, "conversationDefault"],
	] as const)("forwards %s to the router", async (_desc, param, expected, field) => {
		vi.mocked(getConversationDefaultProfile).mockReturnValue(
			param === undefined ? expected : "work",
		);

		await browserNavigateTool.execute(
			`call-prof-${field}-${expected}`,
			{ url: "https://example.com/", ...(param ? { profile: param } : {}) },
			undefined,
			undefined,
			mockCtx as any,
		);

		// The router derives the missing-name policy from whether `profile` was
		// explicit; the tool never sets the field itself.
		const navOpts = navigate.mock.calls.at(-1)?.[1] as Record<string, unknown>;
		expect(navOpts[field]).toBe(expected);
		expect(navOpts).not.toHaveProperty("profileSource");
	});

	it("omits profile when no param and no conversation default are set", async () => {
		vi.mocked(getConversationDefaultProfile).mockReturnValue(undefined);

		await browserNavigateTool.execute(
			"call-prof-5",
			{ url: "https://example.com/" },
			undefined,
			undefined,
			mockCtx as any,
		);

		// No profile key → the router applies the settings default.
		expect(navigate.mock.calls.at(-1)?.[1]).not.toHaveProperty("profile");
	});
});

// ─── Profile-refusal rendering ──────────────────────────────────

describe("profile-refusal rendering", () => {
	let notifySpy: ReturnType<typeof vi.fn>;
	let mockCtx: Record<string, unknown>;
	const refusalError = formatProfileRefusal("Shpping", ["shopping"]);

	beforeEach(() => {
		notifySpy = vi.fn();
		mockCtx = {
			sessionManager: { getSessionId: vi.fn(() => "test-session") },
			ui: {
				notify: notifySpy,
				setStatus: vi.fn(),
				theme: { fg: vi.fn((_c: string, t: string) => t) },
			},
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders the refusal as its own message, without the site-failure prefix", async () => {
		const { navigate } = await import("../core/router.js");
		(navigate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			success: false,
			url: "https://example.com/",
			title: "",
			snapshot: "",
			elementCount: 0,
			error: refusalError,
			errorKind: "profile-refusal",
			backendUsed: "chromium",
		});

		const result = await browserNavigateTool.execute(
			"call-refusal-1",
			{ url: "https://example.com/", profile: "Shpping" },
			undefined,
			undefined,
			mockCtx as any,
		);

		const first = (result.content as Array<{ type: string; text: string }>)[0];
		expect(first?.text).toBe(refusalError);
		expect(first?.text).not.toContain("Failed to load page");
		expect((result.details as Record<string, unknown>).errorKind).toBe(
			"profile-refusal",
		);
		// A refusal is a name-validation failure, not an install problem.
		expect(notifySpy).not.toHaveBeenCalled();
	});

	it("renderResult prefixes the refusal with 'Refused:'", () => {
		const theme = { fg: (_c: string, t: string) => t } as any;
		const rendered = browserNavigateTool.renderResult!(
			{
				content: [{ type: "text", text: refusalError }],
				details: { error: true, errorKind: "profile-refusal" },
			} as any,
			{ expanded: false, isPartial: false },
			theme,
			undefined as any,
		);
		const text = (
			rendered as unknown as { render(w: number): string[] }
		).render(200)
			.join("\n");
		expect(text).toContain("Refused:");
		expect(text).not.toContain("Failed:");
	});
});
