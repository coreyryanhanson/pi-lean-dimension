import { vi } from "vitest";

/**
 * Shared ExtensionContext stub for command-handler tests. Superset of the
 * shapes the browser-toggle / browser-install / browser-status tests need;
 * callers add or replace fields via `overrides`.
 */
export function mockCtx(overrides: Record<string, unknown> = {}): any {
	return {
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: { fg: (_c: string, t: string) => t },
			custom: vi.fn(async () => undefined),
		},
		mode: "tui",
		cwd: "/mock",
		hasUI: true,
		isIdle: () => true,
		modelRegistry: {},
		...overrides,
	};
}

/** Capture the /web command handler registered via registerCommand. */
export function captureWebHandler(
	pi: unknown,
): (args: string, ctx: any) => Promise<void> {
	const handler = (pi as any).registerCommand.mock.calls[0]?.[1]?.handler;
	if (!handler) throw new Error("Handler was not registered");
	return handler;
}
