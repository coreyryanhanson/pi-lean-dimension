/**
 * browser-navigate tool tests — notify path when browser isn't installed.
 *
 * Verifies that the tool emits a ctx.ui.notify with install instructions
 * when the browser executable is not installed (simulated via router mock).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { browserNavigateTool } from "../tools/browser-navigate.js";

// ─── Mock router ─────────────────────────────────────────────────

const mockNavigateResult = {
	success: false,
	url: "https://example.com/",
	title: "",
	snapshot: "",
	elementCount: 0,
	error: "Browser not installed. Run: npx playwright install chromium firefox",
	backendUsed: "chromium",
};

vi.mock("../core/router.js", () => ({
	navigate: vi.fn(async () => mockNavigateResult),
	captureScreenshotLine: vi.fn(async () => ""),
}));

// ─── Mock utils — quiet the updateFooterStatus call ──────────────

vi.mock("../tools/utils.js", () => ({
	updateFooterStatus: vi.fn(),
	profileLine: vi.fn(() => ""),
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
			"Browser not installed. Run: npx playwright install chromium firefox",
			"warning",
		);
	});

	it("does not emit notify for non-install errors", async () => {
		// Override mock to return a different error
		const { navigate } = await import("../core/router.js");
		(navigate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			success: false,
			url: "https://example.com/",
			title: "",
			snapshot: "",
			elementCount: 0,
			error: "Navigation timeout: page did not load within 30 seconds",
			backendUsed: "chromium",
		});

		await browserNavigateTool.execute(
			"call-2",
			{ url: "https://example.com/", timeout: 5 },
			undefined,
			undefined,
			mockCtx as any,
		);

		// notify should NOT have been called
		expect(notifySpy).not.toHaveBeenCalled();
	});
});
