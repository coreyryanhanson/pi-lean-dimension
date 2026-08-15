/**
 * `/api secrets` command tests — list, assisted entry, manual entry, headless
 * no-op, and the value-never-surfaces invariant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSecretsSubcommand } from "../core/secrets-command.js";
import {
	listDomains,
	listNames,
	readSecret,
	writeSecret,
	setSecretsDir,
} from "../core/secrets-store.js";
import { setUserGuidesDir, invalidateCache } from "../core/guide-store.js";

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
			confirm: vi.fn(async () => true),
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
	it("reports (no secrets stored) with a --help hint when empty (instructions moved to --help)", async () => {
		const ctx = mockCtx();
		await handleSecretsSubcommand("", ctx);
		const text = notified(ctx);
		expect(text).toContain("(no secrets stored)");
		expect(text).toContain("--help");
		// The full instructions block no longer clutters the bare list.
		expect(text).not.toContain("/<domain>.json");
	});

	it("lists domains + names only, a single --help hint line, never values", async () => {
		writeSecret("d.example", "api_key", "super-secret-value");
		writeSecret("d.example", "other", "another-secret");

		const ctx = mockCtx();
		await handleSecretsSubcommand("", ctx);
		const text = notified(ctx);
		expect(text).toContain("d.example");
		expect(text).toContain("api_key");
		expect(text).not.toContain("super-secret-value");
		expect(text).not.toContain("another-secret");
		expect(text).toContain("--help");
	});
});

describe("/api secrets --help", () => {
	it("prints usage + full file-write instructions", async () => {
		const ctx = mockCtx();
		await handleSecretsSubcommand("--help", ctx);
		const text = notified(ctx);
		expect(text).toContain("Usage: /api secrets");
		expect(text).toContain("/<domain>.json");
	});

	it("accepts the bare 'help' alias", async () => {
		const ctx = mockCtx();
		await handleSecretsSubcommand("help", ctx);
		expect(notified(ctx)).toContain("Usage: /api secrets");
	});
});

describe("/api secrets <domain> <name> — manual entry", () => {
	it("prompts for a value and stores it; never emits the value", async () => {
		const ctx = mockCtx();
		ctx.ui.input.mockResolvedValueOnce("demo-key-abc");

		await handleSecretsSubcommand("d.example api_key", ctx);

		const promptTitle = ctx.ui.input.mock.calls[0]?.[0] as string;
		expect(promptTitle).toContain("d.example");
		expect(promptTitle).toContain("api_key");
		expect(readSecret("d.example", "api_key")).toBe("demo-key-abc");
		expect(notified(ctx)).toContain("Stored secret 'api_key'");
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
			.mockResolvedValueOnce("api_key")
			.mockResolvedValueOnce("demo-key-xyz");

		await handleSecretsSubcommand("d.example", ctx);

		expect(readSecret("d.example", "api_key")).toBe("demo-key-xyz");
		const text = notified(ctx);
		expect(text).toContain("Secrets for 'd.example'");
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

	it("guide-aware: single declared secret name prompts its value directly", async () => {
		const guidesDir = mkdtempSync(join(tmpdir(), "secrets-cmd-guides-"));
		try {
			mkdirSync(join(guidesDir, "d.example"), { recursive: true });
			writeFileSync(
				join(guidesDir, "d.example", "guide.md"),
				`---
domains: [d.example]
apiHost: https://d.example
auth:
  kind: static-key
  secretRefs:
    x-cg-demo-api-key: api_key
  requires:
    - api_key
operations:
  - name: ping
    via: restGet
    path: /ping
    accept: json
---
body
`,
			);
			setUserGuidesDir(guidesDir);
			invalidateCache();

			const ctx = mockCtx();
			ctx.ui.input.mockResolvedValueOnce("demo-key-abc");
			await handleSecretsSubcommand("d.example", ctx);

			// Single declared name → exactly ONE prompt, for the value.
			expect(ctx.ui.input).toHaveBeenCalledTimes(1);
			const prompt = ctx.ui.input.mock.calls[0]?.[0] as string;
			expect(prompt).toContain("d.example");
			expect(prompt).toContain("api_key");
			expect(readSecret("d.example", "api_key")).toBe("demo-key-abc");
			const text = notified(ctx);
			expect(text).toContain("Declared (guide): api_key");
			expect(text).not.toContain("demo-key-abc");
		} finally {
			rmSync(guidesDir, { recursive: true, force: true });
		}
	});
});

describe("/api secrets <domain> <name> --delete", () => {
	it("deletes a single secret without confirmation; value never resurfaces", async () => {
		writeSecret("d.example", "k", "secret-42");

		const ctx = mockCtx();
		await handleSecretsSubcommand("d.example k --delete", ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(readSecret("d.example", "k")).toBeNull();
		const text = notified(ctx);
		expect(text).toContain("Deleted secret 'k'");
		expect(text).not.toContain("secret-42");
	});

	it("reports a missing name without deleting anything", async () => {
		writeSecret("d.example", "keep", "1");

		const ctx = mockCtx();
		await handleSecretsSubcommand("d.example nope --delete", ctx);
		expect(readSecret("d.example", "keep")).toBe("1");
		expect(notified(ctx)).toContain("No secret 'nope'");
	});

	it("prunes the domain file after deleting the last secret", async () => {
		writeSecret("d.example", "k", "1");
		await handleSecretsSubcommand("d.example k --delete", mockCtx());
		expect(listDomains()).toEqual([]);
	});

	it("headless works without prompting or hanging", async () => {
		writeSecret("d.example", "k", "1");
		const ctx = mockCtx({ hasUI: false });
		await handleSecretsSubcommand("d.example k --delete", ctx);
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(readSecret("d.example", "k")).toBeNull();
	});
});

describe("/api secrets <domain> --delete", () => {
	it("confirms, then deletes all secrets for a domain", async () => {
		writeSecret("d.example", "a", "1");
		writeSecret("d.example", "b", "2");

		const ctx = mockCtx();
		await handleSecretsSubcommand("d.example --delete", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(readSecret("d.example", "a")).toBeNull();
		expect(readSecret("d.example", "b")).toBeNull();
		expect(notified(ctx)).toContain("Deleted all secrets for 'd.example'.");
	});

	it("aborts (nothing deleted) when the user declines the confirm", async () => {
		writeSecret("d.example", "a", "1");
		const ctx = mockCtx({
			ui: { confirm: vi.fn(async () => false), notify: vi.fn() },
		});

		await handleSecretsSubcommand("d.example --delete", ctx);
		expect(readSecret("d.example", "a")).toBe("1");
		expect(notified(ctx)).toContain("Cancelled");
	});

	it("headless deletes all without prompting or hanging", async () => {
		writeSecret("d.example", "a", "1");
		const ctx = mockCtx({ hasUI: false });
		await handleSecretsSubcommand("d.example --delete", ctx);
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(readSecret("d.example", "a")).toBeNull();
	});

	it("reports when a domain has no secrets", async () => {
		const ctx = mockCtx();
		await handleSecretsSubcommand("empty.example --delete", ctx);
		expect(notified(ctx)).toContain("No secrets stored");
	});
});

describe("/api secrets --delete misuse", () => {
	it("bare --delete without a domain is a usage warning", async () => {
		const ctx = mockCtx();
		await handleSecretsSubcommand("--delete", ctx);
		expect(notified(ctx)).toContain("Usage");
	});

	it("--help wins over --delete", async () => {
		const ctx = mockCtx();
		await handleSecretsSubcommand("--delete --help", ctx);
		expect(notified(ctx)).toContain("Usage: /api secrets");
	});
});
