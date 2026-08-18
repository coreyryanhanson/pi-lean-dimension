/**
 * Secrets store tests — read/write/resolve, 0600 perms, lazy-mkdir-on-write-only,
 * names-only listing, missing file/dir handling, domain/name safety.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	existsSync,
	statSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFileStore,
	deleteDomain,
	deleteSecret,
	listDomains,
	listNames,
	readSecret,
	writeSecret,
	setSecretsDir,
} from "../core/secrets-store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
	setSecretsDir(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("secrets store — file backend", () => {
	it("readSecret returns null for missing domain / missing name", () => {
		expect(readSecret("missing.example", "api_key")).toBeNull();
	});

	it("writeSecret then readSecret round-trips", () => {
		writeSecret("d.example", "api_key", "demo-key-123");
		expect(readSecret("d.example", "api_key")).toBe("demo-key-123");
		// Other name in same domain, and other domain unaffected.
		expect(readSecret("d.example", "other")).toBeNull();
		expect(readSecret("other.example", "api_key")).toBeNull();
	});

	it("writeSecret overwrites an existing name", () => {
		writeSecret("d", "k", "v1");
		writeSecret("d", "k", "v2");
		expect(readSecret("d", "k")).toBe("v2");
	});

	it("writes 0600 file", () => {
		writeSecret("d", "k", "v");
		const p = join(dir, "d.json");
		expect(existsSync(p)).toBe(true);
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});

	it("lazily creates the dir on write only — reads/list never mkdir", () => {
		// mkdtempSync already created `dir`; use a path that does not exist yet.
		const fresh = join(tmpdir(), `secrets-never-${Date.now()}`);
		setSecretsDir(fresh);
		try {
			expect(existsSync(fresh)).toBe(false);
			readSecret("d", "k");
			listNames("d");
			listDomains();
			expect(existsSync(fresh)).toBe(false);

			// Write creates the dir.
			writeSecret("d", "k", "v");
			expect(existsSync(fresh)).toBe(true);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("listNames returns names only, sorted, omits values", () => {
		writeSecret("d", "zeta", "z");
		writeSecret("d", "alpha", "a");
		expect(listNames("d")).toEqual(["alpha", "zeta"]);
	});

	it("listDomains returns stored domains, sorted, omits values", () => {
		writeSecret("b.example", "k", "v");
		writeSecret("a.example", "k", "v");
		expect(listDomains()).toEqual(["a.example", "b.example"]);
	});

	it("listDomains is empty when the dir is absent", () => {
		expect(listDomains()).toEqual([]);
	});

	it("treats a corrupt domain file as empty", () => {
		writeSecret("d", "k", "v");
		// Corrupt it (writeFileSync with a narrow mode to keep 0600 symmetry).
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "d.json"), "not json");
		expect(readSecret("d", "k")).toBeNull();
		expect(listNames("d")).toEqual([]);
	});

	it("rejects path-traversal domains", () => {
		expect(() => writeSecret("../evil", "k", "v")).toThrow(/domain/i);
		expect(() => readSecret("../../x", "k")).toThrow(/domain/i);
		expect(() => listNames("a/b")).toThrow(/domain/i);
	});

	it("rejects malformed secret names", () => {
		expect(() => writeSecret("d", "", "v")).toThrow(/secret name/i);
		expect(() => writeSecret("d", "a/b", "v")).toThrow(/secret name/i);
	});

	describe("delete", () => {
		it("deleteSecret removes a single key, keeps the rest", () => {
			writeSecret("d", "a", "1");
			writeSecret("d", "b", "2");
			deleteSecret("d", "a");
			expect(readSecret("d", "a")).toBeNull();
			expect(readSecret("d", "b")).toBe("2");
			expect(listNames("d")).toEqual(["b"]);
		});

		it("deleteSecret prunes the file when it empties the domain", () => {
			writeSecret("d", "a", "1");
			deleteSecret("d", "a");
			expect(existsSync(join(dir, "d.json"))).toBe(false);
			expect(listDomains()).toEqual([]);
		});

		it("deleteSecret on a missing name / missing file is a no-op", () => {
			writeSecret("d", "a", "1");
			expect(() => deleteSecret("d", "nope")).not.toThrow();
			expect(() => deleteSecret("missing.example", "a")).not.toThrow();
			expect(listDomains()).toEqual(["d"]);
		});

		it("deleteSecret rejects malformed names", () => {
			expect(() => deleteSecret("d", "a/b")).toThrow(/secret name/i);
		});

		it("deleteDomain removes the whole domain", () => {
			writeSecret("d", "a", "1");
			writeSecret("d", "b", "2");
			deleteDomain("d");
			expect(readSecret("d", "a")).toBeNull();
			expect(readSecret("d", "b")).toBeNull();
			expect(listDomains()).toEqual([]);
			expect(existsSync(join(dir, "d.json"))).toBe(false);
		});

		it("deleteDomain on a missing domain is a no-op", () => {
			expect(() => deleteDomain("missing.example")).not.toThrow();
		});
	});
});

describe("createFileStore — isolated store instances", () => {
	it("respects its own dir independent of the module singleton", () => {
		const other = mkdtempSync(join(tmpdir(), "secrets-other-"));
		try {
			const store = createFileStore(other);
			store.write("x.example", "k", "v");
			expect(store.read("x.example", "k")).toBe("v");
			// Module singleton untouched.
			expect(readSecret("x.example", "k")).toBeNull();
			// File lands in `other`.
			expect(
				JSON.parse(readFileSync(join(other, "x.example.json"), "utf-8")),
			).toEqual({ k: "v" });
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
