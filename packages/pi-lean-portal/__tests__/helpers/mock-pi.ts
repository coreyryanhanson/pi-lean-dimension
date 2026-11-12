import { vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";

/**
 * Shared ExtensionAPI stub for command-handler tests (lifted from
 * browser-toggle.test.ts's local mockPi). Defaults to no tools — dispatch
 * tests exercise command handlers, not toolset membership; pass
 * `initialTools`/`extraTools` when a test needs them.
 */
export function mockPi(
	initialTools?: string[],
	extraTools: { name: string; description?: string }[] = [],
): {
	pi: ExtensionAPI;
	events: EventEmitter;
	handlers: Map<string, Array<(...args: any[]) => void>>;
	entryCalls: Array<{ customType: string; data: unknown }>;
} {
	let active = initialTools ?? [];
	const eventEmitter = new EventEmitter();
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const entryCalls: Array<{ customType: string; data: unknown }> = [];

	const pi = {
		getAllTools: vi.fn(() => [...extraTools] as any),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
		appendEntry: vi.fn((customType: string, data?: unknown) => {
			entryCalls.push({ customType, data });
		}),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(<T>(event: string, handler: (event: T, ctx: any) => void) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler as any);
		}),
		get events() {
			return {
				emit: (channel: string, data: unknown) => eventEmitter.emit(channel, data),
				on: (channel: string, handler: (data: unknown) => void) => {
					eventEmitter.on(channel, handler);
					return () => eventEmitter.off(channel, handler);
				},
			};
		},
	} as unknown as ExtensionAPI;

	return { pi, events: eventEmitter, handlers, entryCalls };
}

/**
 * Shared ExtensionContext stub for command-handler tests. Superset of the
 * shapes the browser-toggle / browser-install / browser-status tests need;
 * callers add or replace fields via `overrides`.
 */
export function mockCtx(overrides: Record<string, unknown> = {}): any {
	return {
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "test-session-id",
		},
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: { fg: (_c: string, t: string) => t },
			custom: vi.fn(async () => undefined),
			// Resolves undefined = editor cancel, so no test silently writes.
			editor: vi.fn(async () => undefined),
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
