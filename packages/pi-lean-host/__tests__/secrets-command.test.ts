/**
 * `/api secrets` command tests — list, assisted entry, manual entry, headless
 * no-op, and the value-never-surfaces invariant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSecretsSubcommand } from "../core/secrets-command.js";
import {
	listNames,
	readSecret,
	writeSecret,
	setSecretsDir,
} from "../core/secrets-store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secrets-cmd-test-"));
	setSecretsDir(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function mockCtx(overrides: Record<string, unknown> = {}): any {
	return {
		hasUI: true,
		ui: {
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
		...overrides,
	};
}

/** Collect notify() calls as a single string. */
function notified(ctx: any): string {
	return ctx.ui.notify.mock.calls.map((c: any[]) => c[0]).join("\n");
}

describe("/api secrets — list", () => {
	it("reports (no secrets stored) with file-write instructions when empty", async () => {
		const ctx = mockCtx();
		await handleSecretsSubcommand("", ctx);
		const text = notified(ctx);
		expect(text).toContain("(no secrets stored)");
		expect(text).toContain("/<domain>.json");
	});

	it("lists domains + names only, never values", async () => {
		writeSecret("api.coingecko.com", "apiKey", "super-secret-value");
		writeSecret("api.coingecko.com", "other", "another-secret");

		const ctx = mockCtx();
		await handleSecretsSubcommand("", ctx);
		const text = notified(ctx);
		expect(text).toContain("api.coingecko.com");
		expect(text).toContain("apiKey");
		expect(text).not.toContain("super-secret-value");
		expect(text).not.toContain("another-secret");
	});
});

describe("/api secrets <domain> <name> — manual entry", () => {
	it("prompts for a value and stores it; never emits the value", async () => {
		const ctx = mockCtx();
		ctx.ui.input.mockResolvedValueOnce("demo-key-abc");

		await handleSecretsSubcommand("api.coingecko.com apiKey", ctx);

		const promptTitle = ctx.ui.input.mock.calls[0]?.[0] as string;
		expect(promptTitle).toContain("api.coingecko.com");
		expect(promptTitle).toContain("apiKey");
		expect(readSecret("api.coingecko.com", "apiKey")).toBe("demo-key-abc");
		expect(notified(ctx)).toContain("Stored secret 'apiKey'");
		expect(notified(ctx)).not.toContain("demo-key-abc");
	});

	it("aborts on cancel (undefined) without writing", async () => {
		const ctx = mockCtx();
		ctx.ui.input.mockResolvedValueOnce(undefined);
		await handleSecretsSubcommand("d.example k", ctx);
		expect(listNames("d.example")).toEqual([]);
	});

	it("aborts on empty value without writing", async () => {
		const ctx = mockCtx();
		ctx.ui.input.mockResolvedValueOnce("   ");
		await handleSecretsSubcommand("d.example k", ctx);
		expect(notified(ctx)).toContain("Aborted");
		expect(listNames("d.example")).toEqual([]);
	});

	it("headless — prints file-write instructions, does not prompt or hang", async () => {
		const ctx = mockCtx({ hasUI: false });
		await handleSecretsSubcommand("d.example k", ctx);
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(notified(ctx)).toContain("d.example.json");
	});
});

describe("/api secrets <domain> — assisted entry", () => {
	it("shows the detail view then prompts name + value", async () => {
		const ctx = mockCtx();
		ctx.ui.input
			.mockResolvedValueOnce("apiKey")
			.mockResolvedValueOnce("demo-key-xyz");

		await handleSecretsSubcommand("api.coingecko.com", ctx);

		expect(readSecret("api.coingecko.com", "apiKey")).toBe("demo-key-xyz");
		const text = notified(ctx);
		expect(text).toContain("Secrets for 'api.coingecko.com'");
		expect(text).not.toContain("demo-key-xyz");
	});

	it("headless — shows stored names + instructions, never prompts", async () => {
		writeSecret("d.example", "k", "secret-42");

		const ctx = mockCtx({ hasUI: false });
		await handleSecretsSubcommand("d.example", ctx);
		expect(ctx.ui.input).not.toHaveBeenCalled();
		const text = notified(ctx);
		expect(text).toContain("k");
		expect(text).not.toContain("secret-42");
	});
});
