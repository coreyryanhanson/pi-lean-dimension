/**
 * GitLab.com recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Tests the live GitLab REST API (`https://gitlab.com/api/v4`): parses the
 * recipe, executes every defined operation against the live endpoint, and
 * asserts the expected shape. The `listProjects` gatherAll drain is the
 * B2 proof: `page`-style pagination + root-array `itemsPath: $` terminates
 * on the empty array `[]` past the last page.
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1.
 * Co-located with the guide it tests.
 */

import { describe, expect } from "vitest";
import {
	withTempDirs,
	createFetchOp,
	itWhen,
} from "../_shared/test-harness.js";

const DOMAIN = "gitlab.com";

// Per-recipe fetch helper (bootstrap shared via createFetchOp; no wrapper —
// GitLab needs no pacing/retry/auth overlay, and each test issues 1 request).
const fetchOp = createFetchOp(DOMAIN);

// Stable public GitLab.com targets (gitlab-org/gitlab, id 278964).
const PROJECT_ID = 278964;
const ISSUE_IID = 612320; // a real issue iid in gitlab-org/gitlab (permanent)
// A fuzzy project search with a bounded multi-page result set (verified
// 2026-08-11: x-total 20 → 2 real pages of 10 + empty terminator). Search
// counts drift on GitLab.com; the assertion only requires >1 page.
const DRAIN_SEARCH = "python-docx";

// ── Authenticated helpers (inject the stored PAT header; used by the users family) ──

/** Resolve the stored key-injected header auth for a live call against the guide. */
async function authFor(guidesDir: string) {
	const { resolveSecretHeaders } = await import("../../core/auth.js");
	const { setUserGuidesDir, findGuidesByDomain } = await import(
		"../../core/guide-store.js"
	);
	setUserGuidesDir(guidesDir);
	const match = findGuidesByDomain(DOMAIN).find(({ guide }) =>
		guide.operations.some((o) => o.name === "getAuthenticatedUser"),
	)!;
	const res = resolveSecretHeaders(match.guide.auth, DOMAIN);
	expect(res.absentRequired).toEqual([]);
	expect(res.headers["Authorization"]).toBeTruthy();
	expect(res.headers["Authorization"]!.startsWith("Bearer ")).toBe(true);
	return {
		guide: match.guide,
		authHeaders: res.headers,
		secretHeaderNames: new Set(["Authorization"]),
	};
}

async function runRestGet(
	guidesDir: string,
	opName: string,
	params: Record<string, unknown>,
) {
	const { restGet } = await import("../../core/helpers.js");
	const { guide, ...auth } = await authFor(guidesDir);
	const op = guide.operations.find((o) => o.name === opName)!;
	return restGet(guide.apiHost, op, params, guide, auth);
}

async function runPaginate(
	guidesDir: string,
	opName: string,
	params: Record<string, unknown>,
) {
	const { paginate } = await import("../../core/helpers.js");
	const { guide, ...auth } = await authFor(guidesDir);
	const op = guide.operations.find((o) => o.name === opName)!;
	return paginate(guide.apiHost, op, params, guide, auth);
}

/** Run a live users op; return {ok, result|msg}. A scope-denied 403 is a valid outcome. */
async function runUsersOp(
	guidesDir: string,
	opName: string,
	params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; msg?: string }> {
	try {
		const { guide } = await authFor(guidesDir);
		const op = guide.operations.find((o) => o.name === opName)!;
		const result =
			op.via === "paginate"
				? await runPaginate(guidesDir, opName, params)
				: await runRestGet(guidesDir, opName, params);
		return { ok: true, result };
	} catch (e) {
		return { ok: false, msg: String((e as Error)?.message ?? e) };
	}
}

describe("GitLab live integration smoke", () => {
	itWhen(
		"parses and loads the GitLab recipe from a temp user dir",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("gitlab.com");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["gitlab.com"]!;
			expect(guide.apiHost).toBe("https://gitlab.com");
			expect(guide.auth.kind).toBe("static-key");
			expect(guide.auth.secretRefs).toEqual({ Authorization: "api_key" });
			expect(guide.auth.optional).toEqual(["api_key"]);
			expect(guide.auth.requires).toBeUndefined();
			for (const op of guide.operations) {
				expect(op.params["Authorization"]).toBeUndefined();
			}
			expect(guide.operations.length).toBe(7);
		}),
	);

	itWhen(
		"listProjects fetches a root-array first page with page=1 (1-based)",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listProjects", {
				search: DRAIN_SEARCH,
			})) as { items: Record<string, unknown>[]; urls: string[] };
			// itemsPath: $ resolves the bare root array.
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			// 1-based page seeding: the first request must carry page=1, never page=0.
			expect(result.urls[0]).toContain("page=1");
			const first = result.items[0]!;
			expect(typeof first["id"]).toBe("number");
			expect(typeof first["path_with_namespace"]).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"listProjects gatherAll drains to empty past the last page (B2 proof)",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const { setUserGuidesDir, findGuidesByDomain } = await import(
				"../../core/guide-store.js"
			);
			const { paginate } = await import("../../core/helpers.js");
			setUserGuidesDir(guidesDir);
			const match = findGuidesByDomain(DOMAIN)[0]!;
			const op = match.guide.operations.find((o) => o.name === "listProjects")!;
			const result = (await paginate(
				match.guide.apiHost,
				op,
				{ search: DRAIN_SEARCH },
				match.guide,
				{ gatherAll: true },
			)) as { items: unknown[]; totalFetched: number; pages: number };
			// More than one page collected (pageSize 10 → needs ≥11 results),
			// and the walk terminated on the empty page — no infinite loop,
			// no 405 offset error.
			expect(result.totalFetched).toBeGreaterThan(10);
			expect(result.totalFetched).toBeLessThan(200);
			expect(result.pages).toBeGreaterThan(1);
			expect(result.items.length).toBe(result.totalFetched);
		}),
		30_000,
	);

	itWhen(
		"getProject returns a single project object by id",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getProject", {
				id: PROJECT_ID,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["id"]).toBe(PROJECT_ID);
			expect(typeof result.data["name"]).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"listProjectIssues lists a public project's issues as a root array",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listProjectIssues", {
				id: PROJECT_ID,
				state: "opened",
			})) as { items: Record<string, unknown>[] };
			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(typeof result.items[0]!["iid"]).toBe("number");
			expect(typeof result.items[0]!["title"]).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"getIssue returns a single issue by project id and iid",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getIssue", {
				id: PROJECT_ID,
				issue_iid: ISSUE_IID,
			})) as { data: Record<string, unknown> };
			expect(result.data).toBeTruthy();
			expect(result.data["iid"]).toBe(ISSUE_IID);
			expect(result.data["project_id"]).toBe(PROJECT_ID);
		}),
		20_000,
	);
});

describe("GitLab (authenticated) — users family", () => {
	itWhen(
		"getAuthenticatedUser returns the token's user (or documented user-scope 403)",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const { ok, result, msg } = await runUsersOp(
				guidesDir,
				"getAuthenticatedUser",
				{},
			);
			if (ok) {
				const data = (result as { data: { username?: string } }).data;
				expect(data).toBeTruthy();
				expect(typeof data.username).toBe("string");
			} else {
				expect(msg).toMatch(/403/);
			}
		}),
		30_000,
	);

	itWhen(
		"listUsers returns users (or documented user-scope 403)",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const { ok, result, msg } = await runUsersOp(guidesDir, "listUsers", {
				username: "octocat",
			});
			if (ok) {
				const items = (result as { items: { id?: number }[] }).items;
				expect(Array.isArray(items)).toBe(true);
			} else {
				expect(msg).toMatch(/403/);
			}
		}),
		30_000,
	);

	itWhen(
		"getUser returns a user by id (or documented user-scope 403)",
		withTempDirs("gitlab.com")(async ({ guidesDir }) => {
			const { ok, result, msg } = await runUsersOp(guidesDir, "getUser", {
				id: 1,
			});
			if (ok) {
				const data = (result as { data: { id?: number } }).data;
				expect(data).toBeTruthy();
				expect(data.id).toBe(1);
			} else {
				expect(msg).toMatch(/403/);
			}
		}),
		30_000,
	);
});
