/**
 * Shared test scaffolding — only helpers duplicated across 3+ test files
 * belong here; single-file fixtures stay in their own test file.
 */

import { vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadApiGuidesFromDir } from "../core/guide-catalog.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";
import type { ApiGuide, Operation } from "../core/api-guide-types.js";

/**
 * Minimal UI mock context. `notify` is always a captured vi.fn; `input`/
 * `confirm` are present as async vi.fn defaults — every command handler
 * awaits them, so the superset base works for all command tests.
 */
export function mockCtx(overrides: Record<string, unknown> = {}): any {
	return {
		hasUI: true,
		ui: {
			input: vi.fn(async () => undefined),
			confirm: vi.fn(async () => true),
			notify: vi.fn(),
		},
		...overrides,
	};
}

/** Collect a mock ctx's notify() calls as one newline-joined string. */
export function notifyText(ctx: any): string {
	return ctx.ui.notify.mock.calls.map((c: unknown[]) => c[0]).join("\n");
}

/** Extract the handler registered for a command via registerCommand. */
export function captureApiHandler(
	pi: ExtensionAPI,
): (args: string, ctx: any) => Promise<void> {
	return (pi.registerCommand as any).mock.calls[0][1].handler;
}

/** Stub global fetch as a token-endpoint mock; returns the underlying vi.fn. */
export function stubTokenEndpoint(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn((url: unknown, init?: RequestInit) =>
		Promise.resolve(handler(String(url), init ?? {})),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

/** JSON token-endpoint response. */
export function tokenResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Passthrough theme: fg returns its text argument unstyled. */
export const mockTheme = {
	fg: (_style: string, text: string) => text,
	bold: (s: string) => s,
} as any;

/**
 * Copy guide files from the api-guides tree into a fresh tmp guides dir under
 * `tmpBase` (one subdir per name), point the guide store at it, and load.
 * `guidesRoot` is the URL of the dir whose subdirs are named by `names`
 * (co-located tests pass `new URL("../", import.meta.url)`). `files` defaults
 * to ["guide.md"]; add "helper.ts" etc. for recipes with sibling files.
 * Returns `{ guides }` — loaded guides keyed by directory name.
 */
export function stageGuides(
	tmpBase: string,
	guidesRoot: URL,
	names: readonly string[],
	files: readonly string[] = ["guide.md"],
): { guides: Record<string, ApiGuide> } {
	const guidesDir = mkdtempSync(join(tmpBase, "guides-"));
	for (const name of names) {
		mkdirSync(join(guidesDir, name), { recursive: true });
		for (const file of files) {
			writeFileSync(
				join(guidesDir, name, file),
				readFileSync(new URL(`${name}/${file}`, guidesRoot), "utf-8"),
			);
		}
	}
	setUserGuidesDir(guidesDir);
	invalidateCache();
	return {
		guides: loadApiGuidesFromDir(guidesDir).guides as Record<string, ApiGuide>,
	};
}

/** Get an op by name from a loaded guide; throws naming the missing op. */
export function findOp(guide: ApiGuide, name: string): Operation {
	const op = guide.operations.find((o) => o.name === name);
	if (!op) throw new Error(`op ${name} not found`);
	return op;
}
