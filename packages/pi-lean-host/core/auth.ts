/**
 * Static-key auth — store-backed secret resolution + metadata-only footer.
 *
 * Both `api-fetch` (injection + fail-closed) and the `api-guide`/`api-fetch`
 * footers share this module. It reads the secrets store and exposes names
 * only — secret values never leave `resolveSecretHeaders`' resolved header
 * map (which only the fetch pipeline consumes, never agent context).
 */

import type { AuthConfig, ApiGuide } from "./api-guide-types.js";
import { readSecret } from "./secrets-store.js";

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
 * Never renders a secret value — names only.
 */
export function authStatusLine(
	auth: AuthConfig,
	domain: string,
): string | undefined {
	if (auth.kind !== "static-key") return undefined;
	const refs = auth.secretRefs;
	if (!refs || Object.keys(refs).length === 0) return undefined;
	const res = resolveSecretHeaders(auth, domain);
	if (res.absentRequired.length > 0) {
		return (
			`🔑 auth: requires ${res.absentRequired.join(", ")} — not provisioned. ` +
			`Run /api secrets ${domain}.`
		);
	}
	// The optional dimension only exists for optional names actually referenced
	// by a secretRef (an `optional` name with no ref is meaningless).
	const refValues = new Set(Object.values(refs));
	const referencedOptional = (auth.optional ?? []).filter((n) =>
		refValues.has(n),
	);
	if (referencedOptional.length > 0) {
		if (res.absentOptional.length > 0) {
			return (
				`🔑 auth: ok (optional ${res.absentOptional.join(", ")} not ` +
				`provisioned — unauthenticated; provision with /api secrets ${domain} for higher limits)`
			);
		}
		return "🔑 auth: ok (optional provisioned)";
	}
	return "🔑 auth: ok";
}
