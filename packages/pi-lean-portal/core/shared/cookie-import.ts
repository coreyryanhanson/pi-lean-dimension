/**
 * Cookie import — Netscape `cookies.txt` parsing and the shared
 * security-lift helper for `/web cookies import <file>`.
 *
 * Both exports are pure logic (no I/O):
 *
 * - `parseCookiesTxt` converts a Netscape cookies.txt export into
 *   `StoredCookie[]`, skipping malformed lines with per-line reason codes
 *   (warn-and-import-the-rest; the only hard abort — zero importable
 *   cookies — is decided by the caller on `cookies.length === 0`).
 * - `liftSecurityAttributes` is the single home for the security rule
 *   applied on both write paths (live-session sync and disk persist):
 *   on a lift-key collision, `httpOnly`/`secure` are upward-only and the
 *   existing `sameSite` wins when present — the Netscape format cannot
 *   express "not HttpOnly" (several exporters omit the `#HttpOnly_`
 *   marker), so an absent marker must never lower an existing attribute.
 *
 * @module
 */

import type { Cookie } from "../plugin-api.js";
import { cookieKey, type StoredCookie } from "./storage-state.js";

// ─── Constants ────────────────────────────────────────────────────────

/** Hard cap on a single import file, in bytes — checked via stat before the
 * read so a multi-GB path is refused without being slurped. Independent of
 * the save-side size *warning* threshold. */
export const MAX_COOKIE_IMPORT_BYTES = 10 * 1024 * 1024;

/** Chromium's per-cookie cap (RFC 6265 §6.1) — name+value bytes, exclusive. */
const MAX_COOKIE_BYTES = 4096;

/** Playwright rejects `expires` above this at `addCookies` (year-9999 epoch-seconds cap). */
const MAX_COOKIE_EXPIRES = 253402300799;

/** Hostname-shape rule for the domain field (IP literals pass). */
const DOMAIN_RE = /^\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Dotted-quad IPv4 literal — the dot rewrites are skipped for these. */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

const MAX_DOMAIN_LENGTH = 253;

/** C0 and C1 control characters — engine-invalid in cookie names and values. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

// ─── Parsing ──────────────────────────────────────────────────────────

/** Reason codes reported per skipped line (non-sensitive, no cookie data). */
export type SkipReason =
	| "field-count"
	| "bool"
	| "expiry"
	| "engine-shape"
	| "value-length"
	| "empty-key";

export interface ParsedCookiesTxt {
	cookies: StoredCookie[];
	/** Malformed lines: 1-based line number plus a reason code. */
	skipped: Array<{ line: number; reason: SkipReason }>;
	/** Cookies dropped because they were already expired at parse time. */
	expired: number;
	/** Exact-key duplicate lines collapsed by last-wins dedupe. */
	duplicates: number;
}

/**
 * Parse a Netscape cookies.txt export (TAB-separated, 7 fields per line).
 *
 * Malformed lines are skipped and reported (never fatal); expired cookies
 * are dropped and counted before dedupe; exact-key duplicates collapse
 * last-wins. A dot-differing domain pair (`example.com` vs `.example.com`)
 * is two cookies — the leading dot is semantic scope, preserved as-is.
 *
 * `sameSite` is absent from the format, so every parsed cookie gets the
 * browser-default `"Lax"` — provisional for colliding keys (the lift keeps
 * the existing cookie's value) and a documented guess for fresh keys.
 * `httpOnly` is `true` only for `#HttpOnly_` lines; the explicit `false`
 * elsewhere is provisional — the lift keeps it from ever lowering an
 * existing attribute.
 *
 * @param text - The raw file contents.
 * @param nowSec - Current time in unix **seconds** (the `Cookie.expires`
 *                 unit) so expiry tests can be exact; defaults to now.
 */
export function parseCookiesTxt(
	text: string,
	nowSec: number = Math.floor(Date.now() / 1000),
): ParsedCookiesTxt {
	const skipped: ParsedCookiesTxt["skipped"] = [];
	let expired = 0;
	let duplicates = 0;

	// A leading UTF-8 BOM would break the `#`-comment check on the header
	// line and cascade into misleading field-count skips.
	const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);

	// Last-wins dedupe by the match key. Map.set on an existing key keeps
	// the first occurrence's position, so output order follows the file.
	const byKey = new Map<string, StoredCookie>();

	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const raw = lines[i] as string;

		// Blank and whitespace-only lines (incl. tab-only padding) are not
		// malformed. A real cookie line always contains tabs, so this cannot
		// eat data — and trimEnd() must never run: it would delete the
		// trailing TAB of a cookie with an empty value.
		if (!/\S/.test(raw)) continue;

		let httpOnly = false;
		let content = raw;
		if (content.startsWith("#")) {
			if (content.startsWith("#HttpOnly_")) {
				httpOnly = true;
				content = content.slice("#HttpOnly_".length);
			} else {
				continue; // comment
			}
		}

		const fields = content.split("\t");
		if (fields.length !== 7) {
			skipped.push({ line: lineNo, reason: "field-count" });
			continue;
		}
		const [domainRaw, subRaw, pathRaw, secureRaw, expiresRaw, name, value] =
			fields as [string, string, string, string, string, string, string];

		// Accept TRUE/FALSE case-insensitively for both boolean fields; any
		// other token is garbage and must not coerce to false.
		const subTok = subRaw.toUpperCase();
		const secTok = secureRaw.toUpperCase();
		if ((subTok !== "TRUE" && subTok !== "FALSE") || (secTok !== "TRUE" && secTok !== "FALSE")) {
			skipped.push({ line: lineNo, reason: "bool" });
			continue;
		}
		const secure = secTok === "TRUE";
		const includeSubdomains = subTok === "TRUE";

		// Strict expiry: digits only (parseInt would silently truncate
		// `9999999999junk`), safe-integer range, and only 0/-1 mean "session".
		if (
			!/^-?\d+$/.test(expiresRaw) ||
			!Number.isSafeInteger(Number(expiresRaw)) ||
			(Number(expiresRaw) < 0 && Number(expiresRaw) !== -1)
		) {
			skipped.push({ line: lineNo, reason: "expiry" });
			continue;
		}
		const rawExpires = Number(expiresRaw);
		const expires = rawExpires === 0 || rawExpires === -1 ? -1 : rawExpires;

		if (!domainRaw || !name) {
			skipped.push({ line: lineNo, reason: "empty-key" });
			continue;
		}

		// Engine-shape gate — one bad cookie in the merged set would brick
		// every later navigate on the profile (throw-class) or be silently
		// dropped while inflating the imported count (drop-class); either
		// way it must never enter storage-state.json.
		if (
			(expires !== -1 && expires > MAX_COOKIE_EXPIRES) ||
			domainRaw.length > MAX_DOMAIN_LENGTH ||
			!DOMAIN_RE.test(domainRaw) ||
			/^\s*$/.test(name) ||
			CONTROL_CHARS_RE.test(name) ||
			CONTROL_CHARS_RE.test(value) ||
			// __Host- with a non-/ path (an empty path field stores as /), a dotted
			// domain, or includeSubdomains=TRUE (the rewrite would add the dot) —
			// all engine-rejected shapes.
			(name.startsWith("__Host-") && ((pathRaw || "/") !== "/" || domainRaw.startsWith(".") || includeSubdomains))
		) {
			skipped.push({ line: lineNo, reason: "engine-shape" });
			continue;
		}

		// String.length counts UTF-16 units; the engine cap is bytes.
		if (Buffer.byteLength(name + value, "utf-8") > MAX_COOKIE_BYTES) {
			skipped.push({ line: lineNo, reason: "value-length" });
			continue;
		}

		// The includeSubdomains flag is the authority on scope: dotless TRUE
		// gains a dot (some exporters omit it), dotted FALSE loses it (a kept
		// dot would widen a host-only cookie to subdomains). IP literals get
		// neither rewrite — `.192.168.1.1` is a cookie Playwright rejects.
		let domain = domainRaw.toLowerCase();
		if (!IPV4_RE.test(domain)) {
			if (includeSubdomains && !domain.startsWith(".")) domain = `.${domain}`;
			else if (!includeSubdomains) domain = domain.replace(/^\./, "");
		}

		const cookie: StoredCookie = {
			name,
			value,
			domain,
			path: pathRaw || "/",
			expires,
			httpOnly,
			secure,
			sameSite: "Lax",
		};

		// Expired-drop runs before dedupe: if dedupe ran first, an expired
		// last-wins duplicate would discard a valid earlier line.
		if (cookie.expires > 0 && cookie.expires <= nowSec) {
			expired++;
			continue;
		}

		const key = cookieKey(cookie);
		if (byKey.has(key)) duplicates++;
		byKey.set(key, cookie);
	}

	return { cookies: [...byKey.values()], skipped, expired, duplicates };
}

// ─── Security lift ────────────────────────────────────────────────────

export interface LiftResult {
	cookies: StoredCookie[];
	/** Lift keys of colliding cookies — imported values replaced existing/live cookies. Dedupes when one incoming set is lifted against several jars. */
	collidedKeys: string[];
	/** Lift keys of cookies dropped by the post-lift `__Secure-`/`__Host-` prefix gate — dedupes like `collidedKeys`. */
	rejectedKeys: string[];
}

/**
 * Merge imported cookies against existing (on-disk or live-jar) cookies
 * with security attributes never lowered: on a lift-key collision,
 * `httpOnly`/`secure` are upward-only in both directions and `sameSite`
 * keeps the existing value when present, falling back to the incoming
 * parsed value when the existing cookie lacks the field. Values and
 * expiries are file-wins — the same incoming-wins rule the disk merge
 * already applies. Fresh keys pass through unchanged.
 *
 * The lift key is the match key with the leading domain dot stripped
 * (dot-blind), derived by re-calling `cookieKey` on normalized fields —
 * never by editing the composite string. Dot-variant pairs stay two
 * cookies (identity is dot-aware) but the lift matches across the dot,
 * so a marker-less import cannot shadow a stored `.example.com` secret
 * with a script-readable duplicate. When several existing cookies share
 * a dot-blind key, booleans OR across matches and `sameSite` comes from
 * the first match carrying the field.
 *
 * Also owns the post-lift prefix gate: a `__Secure-`/`__Host-` cookie is
 * dropped (its key lands in `rejectedKeys`) only if it *still* carries
 * `secure: false` after the lift — parse-time rejection would defeat the
 * repair the lift exists for.
 */
export function liftSecurityAttributes(
	existing: Cookie[],
	incoming: StoredCookie[],
): LiftResult {
	const liftKey = (c: {
		name: string;
		domain?: string;
		path?: string;
	}): string =>
		cookieKey({
			name: c.name,
			domain: (c.domain ?? "").replace(/^\./, ""),
			path: c.path ?? "",
		});

	const byKey = new Map<string, Cookie[]>();
	for (const c of existing) {
		const key = liftKey(c);
		const list = byKey.get(key);
		if (list) list.push(c);
		else byKey.set(key, [c]);
	}

	const cookies: StoredCookie[] = [];
	const collidedKeys: string[] = [];
	const rejectedKeys: string[] = [];

	for (const c of incoming) {
		const key = liftKey(c);
		let lifted = c;
		const matches = byKey.get(key);
		if (matches) {
			collidedKeys.push(key);
			let httpOnly = c.httpOnly;
			let secure = c.secure;
			let sameSite: Cookie["sameSite"];
			for (const m of matches) {
				if (m.httpOnly === true) httpOnly = true;
				if (m.secure === true) secure = true;
				if (sameSite === undefined && m.sameSite !== undefined) {
					sameSite = m.sameSite;
				}
			}
			lifted = { ...c, httpOnly, secure, sameSite: sameSite ?? c.sameSite };
		}
		if (
			!lifted.secure &&
			(lifted.name.startsWith("__Secure-") || lifted.name.startsWith("__Host-"))
		) {
			rejectedKeys.push(key);
			continue;
		}
		cookies.push(lifted);
	}

	return { cookies, collidedKeys, rejectedKeys };
}
