/**
 * resolveOpForExecution — the shared guide-resolution → helper-call →
 * transform-load → auth-resolution → executor-dispatch sequence used by both
 * `api-fetch` (single op) and `/api verify` (a loop over every op). One
 * implementation, two real call sites — a duplicated copy would drift and
 * ship a known second bug, so the sequence lives here.
 *
 * The caller owns everything around it: guide/op resolution (api-fetch by
 * op name across guides, verify by declared order), result formatting, and
 * error/skip rendering. This module only turns a (guide, op) into a
 * successful executor result or a structured non-run outcome.
 *
 * Throws `HelperError` / transport errors up to the caller (both call sites
 * catch); returns a non-`ok` result only for the two conditions that are
 * *not* run failures: a session-disabled local helper (skip, not fail) and
 * a fail-closed missing `requires` secret (short-circuit before dispatch).
 */

import {
	restGet,
	paginate,
	type RestGetResult,
	type PaginateResult,
} from "./helpers.js";
import { callHelper, loadTransform } from "./local-helpers.js";
import {
	resolveSecretHeaders,
	resolveSecretQueryParams,
	authStatusLine,
	canonicalStoreDomain,
	type SecretResolution,
	type QuerySecretResolution,
} from "./auth.js";
import type { ApiGuide, ExecutorVia, Operation } from "./api-guide-types.js";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface ResolveOpOptions {
	/** User-supplied params (pre-helper) — the role `userParams` plays in api-fetch. */
	userParams?: Record<string, unknown>;
	/** paginate: gather all items up to the guide's ceiling. */
	gatherAll?: boolean;
	/** paginate: bypass the nextLink SSRF guard (test hook only). */
	skipSsrfGuard?: boolean;
}

/** Store-injected auth opts, forwarded to the executor and reused by the
 *  caller for the output-channel audit (secret scrub). */
interface AuthOpts {
	authHeaders?: Record<string, string>;
	secretHeaderNames?: Set<string>;
	secretValues?: string[];
	secretQueryParams?: Record<string, string>;
	secretQueryParamNames?: Set<string>;
}

export type ResolveOpResult =
	| {
			ok: true;
			via: ExecutorVia;
			result: RestGetResult | PaginateResult;
			/** Metadata-only auth footer (names only) — undefined for no-auth guides. */
			authFooter?: string;
			/** Resolved auth opts — for the caller's output-channel audit. */
			authOpts: AuthOpts;
	  }
	| {
			ok: false;
			reason: "helper_disabled";
			/** Human-readable reason (the callHelper error message). */
			message: string;
	  }
	| {
			ok: false;
			reason: "auth_required_not_provisioned";
			/** The secret names a `requires` block wants but the store lacks. */
			missing: string[];
	  };

// ═══════════════════════════════════════════════════════════════════
// resolveOpForExecution
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve and execute one operation against its guide.
 *
 * @param guide          The matched ApiGuide.
 * @param op             The operation to execute.
 * @param helperDirName  The guide's directory name — the helper-routing key
 *                       for `callHelper` / `loadTransform` (diverges from the
 *                       routing `domain` in the multi-recipe case).
 * @param opts           Execution options (user params, gatherAll, …).
 */
export async function resolveOpForExecution(
	guide: ApiGuide,
	op: Operation,
	helperDirName: string,
	opts?: ResolveOpOptions,
): Promise<ResolveOpResult> {
	// The canonical secret-store key: `guide.domains[0]` (the plain browsable
	// domain), independent of the routing `domain` the caller was given.
	const storeDomain = canonicalStoreDomain(guide);
	const userParams = opts?.userParams ?? {};

	// 1. Pre-call helper (op.helper === true). A session-disabled helper is a
	//    skip, not a failure — the op is unverifiable this session, not broken.
	let executeParams = userParams;
	if (op.helper === true) {
		const helperResult = await callHelper(helperDirName, op.name, executeParams);
		if (!helperResult.ok) {
			return { ok: false, reason: "helper_disabled", message: helperResult.error };
		}
		executeParams = helperResult.params;
	}

	// 2. Post-response transform (op.transform === true). Loaded once before
	//    dispatch; the executor owns the invocation + its try/catch (a throw
	//    never escapes — it surfaces as a non-blocking transformWarning).
	const transformFn =
		op.transform === true ? await loadTransform(helperDirName) : null;
	if (op.transform === true && transformFn === null) {
		console.warn(
			`⚠ Transform declared but no helper.ts found for ${helperDirName}.`,
		);
	}

	// 3. Auth resolution (kind: static-key) — resolve store-injected headers
	//    AND query params up front so a missing required secret fails closed
	//    BEFORE any request. Values never leave this scope — only header/param
	//    and secret NAMES ever surface to the caller.
	let headerRes: SecretResolution | undefined;
	let queryRes: QuerySecretResolution | undefined;
	if (guide.auth.kind === "static-key") {
		headerRes = resolveSecretHeaders(guide.auth, storeDomain);
		queryRes = resolveSecretQueryParams(guide.auth, storeDomain);
		const missingRequired = [
			...(headerRes.absentRequired ?? []),
			...(queryRes.absentRequired ?? []),
		];
		if (missingRequired.length > 0) {
			return {
				ok: false,
				reason: "auth_required_not_provisioned",
				missing: missingRequired,
			};
		}
	}
	const headerValues = headerRes
		? [...Object.values(headerRes.headers), ...headerRes.rawHeaderValues]
		: [];
	const queryValues = queryRes ? Object.values(queryRes.queryParams) : [];
	const authOpts: AuthOpts =
		headerRes || queryRes
			? {
					...(headerRes
						? {
								authHeaders: headerRes.headers,
								secretHeaderNames: new Set(
									Object.keys(headerRes.headers).map((h) => h.toLowerCase()),
								),
							}
						: {}),
					...(queryRes
						? {
								secretQueryParams: queryRes.queryParams,
								secretQueryParamNames: new Set(Object.keys(queryRes.queryParams)),
							}
						: {}),
					secretValues: [...headerValues, ...queryValues],
				}
			: {};
	const authFooter = authStatusLine(guide.auth, storeDomain);

	// 4. Execute via the declared executor.
	if (op.via === "restGet") {
		const result = await restGet(
			guide.apiHost,
			op,
			executeParams,
			guide,
			authOpts,
			transformFn ?? undefined,
			helperDirName,
		);
		return {
			ok: true,
			via: "restGet",
			result,
			...(authFooter ? { authFooter } : {}),
			authOpts,
		};
	}

	if (op.via === "paginate") {
		const paginateOpts: Parameters<typeof paginate>[4] = {
			...authOpts,
			...(opts?.skipSsrfGuard ? { skipSsrfGuard: true } : {}),
			...(opts?.gatherAll === undefined ? {} : { gatherAll: opts.gatherAll }),
		};
		const result = await paginate(
			guide.apiHost,
			op,
			executeParams,
			guide,
			paginateOpts,
			transformFn ?? undefined,
			helperDirName,
		);
		return {
			ok: true,
			via: "paginate",
			result,
			...(authFooter ? { authFooter } : {}),
			authOpts,
		};
	}

	// TypeScript guard — all ExecutorVia values handled above.
	throw new Error(`Unhandled executor '${op.via as string}'.`);
}
