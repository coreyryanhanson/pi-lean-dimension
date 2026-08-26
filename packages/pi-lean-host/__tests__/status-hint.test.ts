/**
 * status-hint unit tests — the shared 403 classifier used by both api-probe
 * and api-fetch (/api verify).
 *
 * `serverMessage` extracts the server's own reason from a JSON error body;
 * `isPlanGated` flags structured "plan not authorized" signals so a 403
 * reads as a key/subscription limitation, not a recipe bug. Generic fixtures
 * only — no provider-specific naming.
 */

import { describe, it, expect } from "vitest";
import { serverMessage, isPlanGated } from "../core/status-hint.js";

describe("serverMessage", () => {
	it("extracts a top-level message field", () => {
		expect(serverMessage(JSON.stringify({ message: "forbidden" }))).toBe(
			"forbidden",
		);
	});

	it("falls back to the nested status.error_message when no top-level field", () => {
		const body = JSON.stringify({
			status: {
				error_code: 1006,
				error_message: "plan doesn't support this endpoint",
			},
		});
		expect(serverMessage(body)).toBe("plan doesn't support this endpoint");
	});

	it("prefers the top-level message over the nested one", () => {
		const body = JSON.stringify({
			status: { error_message: "nested" },
			message: "top-level",
		});
		expect(serverMessage(body)).toBe("top-level");
	});

	it("returns undefined for non-JSON bodies", () => {
		expect(serverMessage("<error>not json</error>")).toBeUndefined();
	});

	it("returns undefined when no message field exists", () => {
		expect(serverMessage(JSON.stringify({ code: 123 }))).toBeUndefined();
	});

	it("trims and caps long messages", () => {
		const long = "x".repeat(300);
		expect(serverMessage(JSON.stringify({ error: `  ${long}  ` }))).toBe(
			"x".repeat(200),
		);
	});
});

describe("isPlanGated", () => {
	it("flags plan/subscription wording", () => {
		expect(
			isPlanGated(
				JSON.stringify({
					status: { error_message: "plan doesn't support this endpoint" },
				}),
			),
		).toBe(true);
		expect(
			isPlanGated(JSON.stringify({ error: "subscription tier required" })),
		).toBe(true);
	});

	it("flags bare error codes like 1006", () => {
		expect(isPlanGated(JSON.stringify({ status: { error_code: 1006 } }))).toBe(
			true,
		);
	});

	it("does not flag ordinary 403s", () => {
		expect(isPlanGated(JSON.stringify({ error: "forbidden" }))).toBe(false);
		expect(isPlanGated(JSON.stringify({ message: "access denied" }))).toBe(false);
	});

	it("returns false for non-JSON bodies", () => {
		expect(isPlanGated("<error>not json</error>")).toBe(false);
	});
});
