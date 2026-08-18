/**
 * Static-key auth — store-backed secret resolution + metadata-only footer.
 *
 * Both `api-fetch` (injection + fail-closed) and the `api-guide`/`api-fetch`
 * footers share this module. It reads the secrets store and exposes names
 * only — secret values never leave `resolveSecretHeaders`' resolved header
 * map (which only the fetch pipeline consumes, never agent context).
 */

import type { AuthConfig, ApiGuide } from "./api-guide-types.js";
import { readSecret, provisionedDomainsSuffix } from "./secrets-store.js";

/**
 * The canonical secret-store key for a guide: its primary browsable domain.
 * `domains:` is parser-required (an `ApiGuide` always has a non-empty
 * `domains` array), so `domains[0]` is always present. No override field,
 * no organization chain, no dirName fallback.
 */
export function canonicalStoreDomain(guide: ApiGuide): string {
	// `domains` is optional on the Guide base for web-guides, but parser-required
	// (non-empty) on any ApiGuide — see requireStringArray in parse-api-guide.ts.
	return guide.domains![0]!;
}

/** Result of resolving a guide's `auth.secretRefs` against the store. */
export interface SecretResolution {
	/** headerName → resolved value, ready to merge into the request. */
	headers: Record<string, string>;
	/** secret names referenced by `requires` that are absent from the store. */
	absentRequired: string[];
	/** secret names referenced by `optional` that are absent from the store. */
	absentOptional: string[];
}

/** Resolve store-secret headers for a `static-key` guide (no-op otherwise). */
export function resolveSecretHeaders(
	auth: AuthConfig,
	domain: string,
): SecretResolution {
	const headers: Record<string, string> = {};
	const absentRequired: string[] = [];
	const absentOptional: string[] = [];
	const requires = auth.requires ?? [];
	for (const [headerName, secretName] of Object.entries(auth.secretRefs ?? {})) {
		const value = readSecret(domain, secretName);
		if (value === null) {
			if (requires.includes(secretName)) absentRequired.push(secretName);
			else absentOptional.push(secretName);
		} else {
			headers[headerName] = value;
		}
	}
	return { headers, absentRequired, absentOptional };
}

/** Result of resolving a guide's `auth.secretQueryRefs` against the store. */
export interface QuerySecretResolution {
	/** paramName → resolved value, injected below the agent params map. */
	queryParams: Record<string, string>;
	/** secret names referenced by `requires` that are absent from the store. */
	absentRequired: string[];
	/** secret names referenced by `optional` that are absent from the store. */
	absentOptional: string[];
}

/**
 * Resolve store-secret query params for a `static-key` guide. Mirrors
 * `resolveSecretHeaders`: reads the store, splits absents by requires vs
 * optional. The values are injected below the agent-supplied params map by
 * the fetch pipeline and never enter agent context.
 */
export function resolveSecretQueryParams(
	auth: AuthConfig,
	domain: string,
): QuerySecretResolution {
	const queryParams: Record<string, string> = {};
	const absentRequired: string[] = [];
	const absentOptional: string[] = [];
	const requires = auth.requires ?? [];
	for (const [paramName, secretName] of Object.entries(
		auth.secretQueryRefs ?? {},
	)) {
		const value = readSecret(domain, secretName);
		if (value === null) {
			if (requires.includes(secretName)) absentRequired.push(secretName);
			else absentOptional.push(secretName);
		} else {
			queryParams[paramName] = value;
		}
	}
	return { queryParams, absentRequired, absentOptional };
}

/**
 * Metadata-only auth status footer line, shared by `api-guide` and `api-fetch`.
 * Five states: no-auth (→ undefined) / ok / nudge-provision (required absent) /
 * ok-optional (optionals provisioned) / optional-not-provisioned.
 * Covers BOTH `secretRefs` (header) and `secretQueryRefs` (query) ref maps.
 * Never renders a secret value — names only.
 */
export function authStatusLine(
	auth: AuthConfig,
	domain: string,
): string | undefined {
	if (auth.kind !== "static-key") return undefined;
	// Nothing to report when neither ref map has an entry (empty maps are valid
	// = no injection). Length-based, matching the pre-query-ref "no footer"
	// semantics for an empty `secretRefs`, while still covering query-only guides.
	if (
		Object.keys(auth.secretRefs ?? {}).length === 0 &&
		Object.keys(auth.secretQueryRefs ?? {}).length === 0
	)
		return undefined;
	const headerRes = resolveSecretHeaders(auth, domain);
	const queryRes = resolveSecretQueryParams(auth, domain);
	// Dedupe across the two ref maps: a secret injected into both a header
	// and a query param must be named once, not twice.
	const absentRequired = [
		...new Set([...headerRes.absentRequired, ...queryRes.absentRequired]),
	];
	if (absentRequired.length > 0) {
		return (
			`🔑 auth: requires ${absentRequired.join(", ")} — not provisioned. ` +
			`Run /api secrets ${domain}.` +
			provisionedDomainsSuffix(domain)
		);
	}
	// The optional dimension only exists for optional names actually referenced
	// by a ref (an `optional` name with no ref is meaningless).
	const refValues = new Set([
		...Object.values(auth.secretRefs ?? {}),
		...Object.values(auth.secretQueryRefs ?? {}),
	]);
	const referencedOptional = (auth.optional ?? []).filter((n) =>
		refValues.has(n),
	);
	if (referencedOptional.length > 0) {
		const absentOptional = [
			...new Set([...headerRes.absentOptional, ...queryRes.absentOptional]),
		];
		if (absentOptional.length > 0) {
			return (
				`🔑 auth: ok (optional ${absentOptional.join(", ")} not ` +
				`provisioned — unauthenticated; provision with /api secrets ${domain} for higher limits)`
			);
		}
		return "🔑 auth: ok (optional provisioned)";
	}
	return "🔑 auth: ok";
}
