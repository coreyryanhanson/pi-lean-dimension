/**
 * SessionManager unit tests — focused on the updateSession contracts:
 * skip-undefined (an explicit `undefined` must preserve the existing field,
 * not narrow it back to absent) and null-clear (`profileName: null` deletes
 * the field).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { sessionManager } from "../core/shared/session-manager.js";

type Updates = Parameters<typeof sessionManager.updateSession>[1];

describe("SessionManager.updateSession — skip-undefined contract", () => {
	beforeEach(async () => {
		await sessionManager.removeAll();
	});

	it("preserves currentUrl when { currentUrl: undefined } is passed", () => {
		sessionManager.createSession("t1", "chromium");
		sessionManager.updateSession("t1", { currentUrl: "https://example.com" });
		expect(sessionManager.getSession("t1")?.currentUrl).toBe(
			"https://example.com",
		);

		// Under exactOptionalPropertyTypes the typed API rejects an explicit
		// undefined, but a loosely-typed caller (spread/JSON/widened) can still
		// deliver one — the skip-undefined guard must preserve the field.
		sessionManager.updateSession("t1", {
			currentUrl: undefined,
		} as unknown as Updates);
		expect(sessionManager.getSession("t1")?.currentUrl).toBe(
			"https://example.com",
		);
	});

	it("applies real values", () => {
		sessionManager.createSession("t1", "chromium");
		sessionManager.updateSession("t1", {
			currentTitle: "Hello",
			crashed: true,
		});
		const s = sessionManager.getSession("t1");
		expect(s?.currentTitle).toBe("Hello");
		expect(s?.crashed).toBe(true);
	});

	it("clears profileName when null is passed", () => {
		sessionManager.createSession("t1", "chromium");
		sessionManager.updateSession("t1", { profileName: "work" });
		expect(sessionManager.getSession("t1")?.profileName).toBe("work");

		sessionManager.updateSession("t1", { profileName: null });
		expect(sessionManager.getSession("t1")).not.toHaveProperty("profileName");
	});

	it("is a no-op for an unknown taskId", () => {
		expect(() =>
			sessionManager.updateSession("nope", { currentUrl: "x" }),
		).not.toThrow();
	});
});
