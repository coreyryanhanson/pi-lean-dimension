/**
 * A3 — Retry-After parsing unit tests.
 *
 * `waitForRetry` prefers the delay-seconds form, falls back to parsing an
 * HTTP-date form, and falls through to exponential backoff when the date is
 * in the past (server clock skew / already-expired) or absent — never a
 * negative or zero delay. No recipe can reliably force a 429, so the unit
 * test is the proof.
 */

import { describe, it, expect } from "vitest";
import { waitForRetry } from "../core/transport.js";

const BACKOFF = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000);

describe("waitForRetry (A3)", () => {
	it("parses the delay-seconds form", () => {
		expect(waitForRetry({ "retry-after": "5" }, 0)).toBe(5000);
	});

	it("parses the HTTP-date form", () => {
		const future = new Date(Date.now() + 7000).toUTCString();
		const delay = waitForRetry({ "retry-after": future }, 0);
		// ~7s in the future; allow clock skew within a second either way.
		expect(delay).toBeGreaterThan(5000);
		expect(delay).toBeLessThan(8000);
	});

	it("falls back to backoff for a past-dated HTTP-date", () => {
		const past = new Date(Date.now() - 10_000).toUTCString();
		expect(waitForRetry({ "retry-after": past }, 2)).toBe(BACKOFF(2));
	});

	it("falls back to backoff when Retry-After is absent", () => {
		expect(waitForRetry({}, 1)).toBe(BACKOFF(1));
	});

	it("falls back to backoff for a non-numeric, non-date value", () => {
		expect(waitForRetry({ "retry-after": "garbage" }, 3)).toBe(BACKOFF(3));
	});
});
