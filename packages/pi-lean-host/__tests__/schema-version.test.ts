/**
 * schemaVersion metadata-only guard (Sprint 1).
 *
 * Proves GUIDE_SCHEMA_VERSION + the `schemaVersion` frontmatter field are
 * pure attribution: the field never gates, warns, or alters parse behavior.
 * A guide parses identically with the field present, absent, or holding a
 * forward value; a malformed value is tolerated, never a parse gate.
 * This closes the design-doc schema-version gap — the regression guard for
 * the central coupling answer.
 */

import { describe, it, expect } from "vitest";
import { parseApiGuide } from "../core/parse-api-guide.js";
import { GUIDE_SCHEMA_VERSION } from "../core/api-guide-types.js";

const SCHEMA_VERSIONED = `---
kind: api
schemaVersion: 0
domains:
  - example.com
apiHost: https://api.example.com
auth:
  kind: none
responseShape:
  format: json
operations:
  - name: items
    via: restGet
    path: /items
  - name: all
    via: paginate
    path: /all
    pagination:
      style: offset-limit
      itemsPath: items
      pageParam: page
      pageSizeParam: pageSize
---
Body
`;

/** Same recipe with the schemaVersion line (and its surrounding) removed. */
const UNVERSIONED = SCHEMA_VERSIONED.replace("schemaVersion: 0\n", "");

describe("GUIDE_SCHEMA_VERSION constant", () => {
	it("is 0 and exported", () => {
		expect(GUIDE_SCHEMA_VERSION).toBe(0);
	});
});

describe("schemaVersion is metadata-only", () => {
	it("surfaces schemaVersion on the parsed guide when present", () => {
		const result = parseApiGuide(SCHEMA_VERSIONED, { filename: "example.com" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.guide.schemaVersion).toBe(0);
	});

	it("leaves schemaVersion undefined when absent", () => {
		const result = parseApiGuide(UNVERSIONED, { filename: "example.com" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.guide.schemaVersion).toBeUndefined();
	});

	it("a forward value (999) parses identically and is surfaced", () => {
		const forward = SCHEMA_VERSIONED.replace(
			"schemaVersion: 0",
			"schemaVersion: 999",
		);
		const result = parseApiGuide(forward, { filename: "example.com" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.guide.schemaVersion).toBe(999);

		// Same operations + auth as the 0 and absent cases — never changes output.
		const base = parseApiGuide(SCHEMA_VERSIONED, { filename: "example.com" });
		const absent = parseApiGuide(UNVERSIONED, { filename: "example.com" });
		expect(base.ok && absent.ok).toBe(true);
		if (!base.ok || !absent.ok) return;
		expect(result.guide.operations).toEqual(base.guide.operations);
		expect(result.guide.operations).toEqual(absent.guide.operations);
		expect(result.guide.auth).toEqual(base.guide.auth);
		expect(result.guide.auth).toEqual(absent.guide.auth);
	});

	it("a malformed schemaVersion is tolerated, never a parse gate", () => {
		// Non-integer/string values are ignored (metadata stays silent), not
		// schema-version-specific rejections — parse still succeeds.
		for (const bad of [
			"schemaVersion: notanumber",
			"schemaVersion: 1.5",
			"schemaVersion: -3",
		]) {
			const raw = SCHEMA_VERSIONED.replace("schemaVersion: 0", bad);
			const result = parseApiGuide(raw, { filename: "example.com" });
			expect(result.ok, `should parse with ${JSON.stringify(bad)}`).toBe(true);
			if (result.ok) {
				expect(result.guide.schemaVersion).toBeUndefined();
			}
		}
	});
});
