/**
 * GitHub recipe validity tests — endpoint coverage + live fetch sanity.
 *
 * Parses the recipe, executes every operation against the live endpoint, and
 * asserts the response has the expected shape (200 + non-empty body /
 * expected `itemsPath` for `paginate` ops).
 *
 * Skipped in bare CI — opt in via HOST_INTEGRATION=1.
 * Co-located with the guide it tests.
 *
 * GitHub Unauthenticated rate limit is 60/hr core + 10/min search. Running
 * the FULL file live (53 requests + a few derivation fetches) exceeds the
 * hourly budget. Run a bounded subset per HOST_INTEGRATION session instead:
 *   HOST_INTEGRATION=1 npx vitest run .../api.github.com/ -t "Group A"
 * (the plan's C2 best-effort escape hatch covers partial confirmation).
 */

import { describe, expect } from "vitest";
import {
	withTempDirs,
	createFetchOp,
	itWhen,
} from "../_shared/test-harness.js";

const DOMAIN = "api.github.com";

// ── Per-recipe fetch helper (bootstrap shared via createFetchOp; delay wrapper stays here) ──

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const _fetch = createFetchOp(DOMAIN);

async function fetchOp(
	guidesDir: string,
	name: string,
	params: Record<string, unknown> = {},
) {
	await delay(100);
	return _fetch(guidesDir, name, params);
}

// ── Stable live identifiers (canonical GitHub test fixtures) ──────────
const OWNER = "octocat";
const REPO = "Hello-World";
const USER = "octocat";
const ORG = "github";
const BRANCH = "master";
const ISSUE = 1;
// The well-known initial commit of octocat/Hello-World (used across GitHub's
// own REST docs examples). Derived tree/blob SHAs come from it at runtime.
const FIRST_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
// Fixture repo with a durable pull-review-comment (PR #16) and one label
// ("dependencies") — octocat/Hello-World has neither.
const REL_OWNER = "torvalds";
const REL_REPO = "linux";
// GitHub Releases (distinct from git tags): octocat/Hello-World and
// torvalds/linux publish none, so release ops run against nodejs/node, which
// ships tagged GitHub Releases (current latest v26.x+).
const RELEASE_OWNER = "nodejs";
const RELEASE_REPO = "node";

function expectFlatNonEmpty(items: unknown[]): void {
	expect(Array.isArray(items)).toBe(true);
	expect(items.length).toBeGreaterThan(0);
}

// ═══════════════════════════════════════════════════════════════════
// Baseline
// ═══════════════════════════════════════════════════════════════════

describe("GitHub live integration smoke", () => {
	itWhen(
		"parses and loads the recipe with all 53 ops",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const { loadApiGuidesFromDir } = await import(
				"../../core/parse-api-guide.js"
			);
			const loaded = loadApiGuidesFromDir(guidesDir);
			expect(Object.keys(loaded.guides)).toContain("api.github.com");
			expect(loaded.malformed).toHaveLength(0);

			const guide = loaded.guides["api.github.com"]!;
			expect(guide.apiHost).toBe("https://api.github.com");
			expect(guide.auth.kind).toBe("none");
			expect(guide.operations.length).toBe(52);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group A — Repository info (10 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group A — repository info", () => {
	itWhen(
		"searchRepos returns results via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchRepos", {
				q: "octocat",
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"listOrgRepos lists an org's public repos",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listOrgRepos", {
				org: ORG,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
			expect(result.items[0]).toMatchObject({ full_name: expect.any(String) });
		}),
		20_000,
	);

	itWhen(
		"getRepo returns a single repo",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRepo", {
				owner: OWNER,
				repo: REPO,
			})) as { data: { full_name?: string; id?: number } };
			expect(result.data).toBeTruthy();
			expect(result.data.full_name).toBe(`${OWNER}/${REPO}`);
			expect(typeof result.data.id).toBe("number");
		}),
		20_000,
	);

	itWhen(
		"getRepoLanguages returns a language→bytes map",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRepoLanguages", {
				owner: OWNER,
				repo: REPO,
			})) as { data: Record<string, number> };
			expect(result.data).toBeTruthy();
			expect(typeof result.data).toBe("object");
			expect(Array.isArray(result.data)).toBe(false);
		}),
		20_000,
	);

	itWhen(
		"getRepoTopics returns a names envelope",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRepoTopics", {
				owner: OWNER,
				repo: REPO,
			})) as { data: { names?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(Array.isArray(result.data.names)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"listRepoTags returns a flat array via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRepoTags", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"listRepoContributors returns contributors",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRepoContributors", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"listPublicRepos lists public repos",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listPublicRepos")) as {
				items: unknown[];
			};
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"listUserRepos lists a user's public repos",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listUserRepos", {
				username: USER,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"listRepoActivities returns a flat array via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRepoActivities", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group B — Repository contents (2 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group B — repository contents", () => {
	itWhen(
		"getRepoReadme returns the base64-encoded README",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRepoReadme", {
				owner: OWNER,
				repo: REPO,
			})) as { data: { name?: string; encoding?: string; content?: string } };
			expect(result.data).toBeTruthy();
			expect(typeof result.data.name).toBe("string");
			expect(result.data.encoding).toBe("base64");
			expect(typeof result.data.content).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"getRepoContent fetches a file at a path",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getRepoContent", {
				owner: OWNER,
				repo: REPO,
				path: "README",
			})) as { data: { type?: string; name?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.type).toBe("file");
			expect(result.data.name).toBe("README");
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group C — Commits & branches (7 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group C — commits & branches", () => {
	itWhen(
		"listCommits returns a flat array via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listCommits", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
			expect(result.items[0]).toMatchObject({ sha: expect.any(String) });
		}),
		20_000,
	);

	itWhen(
		"getCommit returns a single commit",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getCommit", {
				owner: OWNER,
				repo: REPO,
				ref: FIRST_COMMIT,
			})) as { data: { sha?: string; commit?: object } };
			expect(result.data).toBeTruthy();
			expect(result.data.sha).toBe(FIRST_COMMIT);
			expect(typeof result.data.commit).toBe("object");
		}),
		20_000,
	);

	itWhen(
		"compareCommits compares two refs",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "compareCommits", {
				owner: OWNER,
				repo: REPO,
				basehead: `${BRANCH}...${BRANCH}`,
			})) as { data: { status?: string; commits?: unknown[] } };
			expect(result.data).toBeTruthy();
			expect(typeof result.data.status).toBe("string");
			expect(Array.isArray(result.data.commits)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"listCommitBranches lists branches containing the commit",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listCommitBranches", {
				owner: OWNER,
				repo: REPO,
				ref: FIRST_COMMIT,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"listCommitPulls lists PRs associated with the commit",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listCommitPulls", {
				owner: OWNER,
				repo: REPO,
				ref: FIRST_COMMIT,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"listBranches lists the repo's branches",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listBranches", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"getBranch returns a single branch",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getBranch", {
				owner: OWNER,
				repo: REPO,
				branch: BRANCH,
			})) as { data: { name?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.name).toBe(BRANCH);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group D — Issues & comments (4 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group D — issues & comments", () => {
	itWhen(
		"listRepoIssues lists the repo's issues",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRepoIssues", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"getIssue returns a single issue",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getIssue", {
				owner: OWNER,
				repo: REPO,
				number: ISSUE,
			})) as { data: { number?: number; title?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.number).toBe(ISSUE);
			expect(typeof result.data.title).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"getIssueComment returns a single comment",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			// Derive a real comment id from the issue-scoped list.
			const list = (await fetchOp(guidesDir, "listIssueComments", {
				owner: OWNER,
				repo: REPO,
				number: ISSUE,
			})) as { items: { id?: number }[] };
			expectFlatNonEmpty(list.items);
			const id = list.items[0]!.id;
			const result = (await fetchOp(guidesDir, "getIssueComment", {
				owner: OWNER,
				repo: REPO,
				id,
			})) as { data: { id?: number; body?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.id).toBe(id);
			expect(typeof result.data.body).toBe("string");
		}),
		30_000,
	);

	itWhen(
		"listIssueComments lists an issue's comments",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listIssueComments", {
				owner: OWNER,
				repo: REPO,
				number: ISSUE,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group E — Pull requests & comments (6 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group E — pull requests & comments", () => {
	itWhen(
		"listPulls lists the repo's pull requests",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listPulls", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"getPull returns a single pull request",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const pulls = (await fetchOp(guidesDir, "listPulls", {
				owner: OWNER,
				repo: REPO,
			})) as { items: { number?: number }[] };
			expectFlatNonEmpty(pulls.items);
			const number = pulls.items[0]!.number;
			const result = (await fetchOp(guidesDir, "getPull", {
				owner: OWNER,
				repo: REPO,
				number,
			})) as { data: { number?: number; title?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.number).toBe(number);
			expect(typeof result.data.title).toBe("string");
		}),
		30_000,
	);

	itWhen(
		"listPullCommits lists commits in a PR",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const pulls = (await fetchOp(guidesDir, "listPulls", {
				owner: OWNER,
				repo: REPO,
			})) as { items: { number?: number }[] };
			expectFlatNonEmpty(pulls.items);
			const result = (await fetchOp(guidesDir, "listPullCommits", {
				owner: OWNER,
				repo: REPO,
				number: pulls.items[0]!.number,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"listPullFiles lists files changed in a PR",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const pulls = (await fetchOp(guidesDir, "listPulls", {
				owner: OWNER,
				repo: REPO,
			})) as { items: { number?: number }[] };
			expectFlatNonEmpty(pulls.items);
			const result = (await fetchOp(guidesDir, "listPullFiles", {
				owner: OWNER,
				repo: REPO,
				number: pulls.items[0]!.number,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"listPullReviewComments lists review comments on a PR",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const pulls = (await fetchOp(guidesDir, "listPulls", {
				owner: OWNER,
				repo: REPO,
			})) as { items: { number?: number }[] };
			expectFlatNonEmpty(pulls.items);
			const result = (await fetchOp(guidesDir, "listPullReviewComments", {
				owner: OWNER,
				repo: REPO,
				number: pulls.items[0]!.number,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"getPullReviewComment returns a real review comment",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			// Hello-World's PRs have no review comments, so a real id can't be
			// derived there. Use a real, durable review comment on torvalds/linux
			// PR #16 (review comment ids are permanent).
			const ID = 621580;
			const result = (await fetchOp(guidesDir, "getPullReviewComment", {
				owner: REL_OWNER,
				repo: REL_REPO,
				id: ID,
			})) as { data: { id?: number; body?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.id).toBe(ID);
			expect(typeof result.data.body).toBe("string");
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group F — Search (6 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group F — search", () => {
	itWhen(
		"searchIssues returns results via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchIssues", {
				q: `repo:${OWNER}/${REPO}`,
			})) as { items: { id?: number }[] };
			expectFlatNonEmpty(result.items);
			expect(typeof result.items[0]!.id).toBe("number");
		}),
		20_000,
	);

	itWhen(
		"searchUsers returns results via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchUsers", {
				q: "octocat",
			})) as { items: { login?: string }[] };
			expectFlatNonEmpty(result.items);
			expect(typeof result.items[0]!.login).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"searchCommits returns results via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			// Commit search requires actual search text — a qualifier-only query
			// (e.g. `repo:…`) returns 422. A global text query is stable + non-empty.
			const result = (await fetchOp(guidesDir, "searchCommits", {
				q: "Merge pull request",
			})) as { items: { sha?: string }[] };
			expectFlatNonEmpty(result.items);
			expect(typeof result.items[0]!.sha).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"searchTopics returns results via paginate",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "searchTopics", {
				q: "javascript",
			})) as { items: { name?: string }[] };
			expectFlatNonEmpty(result.items);
			expect(typeof result.items[0]!.name).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"searchLabels returns results scoped to a repository id",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			// Hello-World defines no labels, so scope to torvalds/linux (which has
			// the default labels) and derive its repository id from getRepo.
			const repo = (await fetchOp(guidesDir, "getRepo", {
				owner: REL_OWNER,
				repo: REL_REPO,
			})) as { data: { id?: number } };
			expect(typeof repo.data.id).toBe("number");
			const result = (await fetchOp(guidesDir, "searchLabels", {
				q: "dependencies",
				repository_id: repo.data.id,
			})) as { items: { id?: number }[] };
			expectFlatNonEmpty(result.items);
			expect(typeof result.items[0]!.id).toBe("number");
		}),
		30_000,
	);

	itWhen(
		"searchCode documents the auth-required error shape (GitHub requires a token)",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			// GitHub search-code is the one search endpoint that requires
			// authentication even for a read; unauthenticated it returns 401.
			// Asserting the documented error shape (resources.data.gov pattern),
			// not a 200 — the recipe is auth: none.
			await expect(
				fetchOp(guidesDir, "searchCode", { q: `repo:${OWNER}/${REPO}` }),
			).rejects.toThrow(/Unexpected HTTP 401|403/);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group G — Users & organizations (5 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group G — users & organizations", () => {
	itWhen(
		"getUser returns a user profile",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getUser", {
				username: USER,
			})) as { data: { login?: string; id?: number } };
			expect(result.data).toBeTruthy();
			expect(result.data.login).toBe(USER);
			expect(typeof result.data.id).toBe("number");
		}),
		20_000,
	);

	itWhen(
		"listUsers lists public users",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listUsers")) as {
				items: unknown[];
			};
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"getOrg returns an org profile",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getOrg", {
				org: ORG,
			})) as { data: { login?: string; id?: number } };
			expect(result.data).toBeTruthy();
			expect(result.data.login).toBe(ORG);
			expect(typeof result.data.id).toBe("number");
		}),
		20_000,
	);

	itWhen(
		"listOrgs lists public organizations",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listOrgs")) as {
				items: unknown[];
			};
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"listUserOrgs lists a user's organizations",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listUserOrgs", {
				username: USER,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group H — Releases (3 ops; verified against torvalds/linux)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group H — releases", () => {
	itWhen(
		"listReleases lists a repo's releases",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listReleases", {
				owner: RELEASE_OWNER,
				repo: RELEASE_REPO,
			})) as { items: unknown[] };
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"getLatestRelease returns the latest release",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getLatestRelease", {
				owner: RELEASE_OWNER,
				repo: RELEASE_REPO,
			})) as { data: { tag_name?: string; name?: unknown } };
			expect(result.data).toBeTruthy();
			expect(typeof result.data.tag_name).toBe("string");
		}),
		20_000,
	);

	itWhen(
		"getReleaseByTag returns a release by tag name",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const list = (await fetchOp(guidesDir, "listReleases", {
				owner: RELEASE_OWNER,
				repo: RELEASE_REPO,
			})) as { items: { tag_name?: string }[] };
			expectFlatNonEmpty(list.items);
			const tag = list.items[0]!.tag_name!;
			const result = (await fetchOp(guidesDir, "getReleaseByTag", {
				owner: RELEASE_OWNER,
				repo: RELEASE_REPO,
				tag,
			})) as { data: { tag_name?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.tag_name).toBe(tag);
		}),
		30_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group I — Git database (4 ops)
// ═══════════════════════════════════════════════════════════════════

async function firstTreeSha(
	guidesDir: string,
): Promise<{ treeSha: string; blobSha: string }> {
	const commit = (await fetchOp(guidesDir, "getCommit", {
		owner: OWNER,
		repo: REPO,
		ref: FIRST_COMMIT,
	})) as { data: { commit?: { tree?: { sha?: string } } } };
	const treeSha = commit.data.commit?.tree?.sha;
	expect(typeof treeSha).toBe("string");
	const tree = (await fetchOp(guidesDir, "getGitTree", {
		owner: OWNER,
		repo: REPO,
		sha: treeSha,
		recursive: 1,
	})) as { data: { tree?: { type?: string; sha?: string }[] } };
	const blob = (tree.data.tree ?? []).find((e) => e.type === "blob");
	expect(blob).toBeTruthy();
	expect(typeof blob?.sha).toBe("string");
	return { treeSha: treeSha!, blobSha: blob!.sha! };
}

describe("GitHub Group I — git database", () => {
	itWhen(
		"getGitBlob returns a base64-encoded blob",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const { blobSha } = await firstTreeSha(guidesDir);
			const result = (await fetchOp(guidesDir, "getGitBlob", {
				owner: OWNER,
				repo: REPO,
				sha: blobSha,
			})) as { data: { encoding?: string; content?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.encoding).toBe("base64");
			expect(typeof result.data.content).toBe("string");
		}),
		30_000,
	);

	itWhen(
		"getGitTree returns a tree listing",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const { treeSha } = await firstTreeSha(guidesDir);
			const result = (await fetchOp(guidesDir, "getGitTree", {
				owner: OWNER,
				repo: REPO,
				sha: treeSha,
			})) as { data: { tree?: unknown[]; sha?: string } };
			expect(result.data).toBeTruthy();
			expect(result.data.sha).toBe(treeSha);
			expect(Array.isArray(result.data.tree)).toBe(true);
		}),
		30_000,
	);

	itWhen(
		"listMatchingRefs lists refs matching a pattern",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listMatchingRefs", {
				owner: OWNER,
				repo: REPO,
				ref: "heads/master",
			})) as { data: unknown[] };
			expectFlatNonEmpty(result.data);
		}),
		20_000,
	);

	itWhen(
		"getGitRef returns a single reference",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "getGitRef", {
				owner: OWNER,
				repo: REPO,
				ref: "heads/master",
			})) as { data: { ref?: string; object?: { sha?: string } } };
			expect(result.data).toBeTruthy();
			expect(typeof result.data.ref).toBe("string");
			expect(typeof result.data.object?.sha).toBe("string");
		}),
		20_000,
	);
});

// ═══════════════════════════════════════════════════════════════════
// Group J — Activity / events (5 ops)
// ═══════════════════════════════════════════════════════════════════

describe("GitHub Group J — activity / events", () => {
	itWhen(
		"listPublicEvents returns public events",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listPublicEvents")) as {
				items: unknown[];
			};
			expectFlatNonEmpty(result.items);
		}),
		20_000,
	);

	itWhen(
		"listRepoEvents returns a repo's events",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRepoEvents", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"listRepoNetworkEvents returns network events",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listRepoNetworkEvents", {
				owner: OWNER,
				repo: REPO,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"listUserPublicEvents returns a user's public events (may be empty for inactive users)",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			// GitHub events only cover ~90 days; octocat (the canonical test user)
			// is inactive, so this can legitimately be empty. Assert reachability.
			const result = (await fetchOp(guidesDir, "listUserPublicEvents", {
				username: USER,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);

	itWhen(
		"listUserReceivedEvents returns events received by a user",
		withTempDirs("api.github.com")(async ({ guidesDir }) => {
			const result = (await fetchOp(guidesDir, "listUserReceivedEvents", {
				username: USER,
			})) as { items: unknown[] };
			expect(Array.isArray(result.items)).toBe(true);
		}),
		20_000,
	);
});
