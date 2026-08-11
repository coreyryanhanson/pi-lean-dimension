/**
 * SSRF guard — blocks loopback, private RFC1918 ranges, and cloud metadata
 * endpoints on server-supplied URLs only (paginate nextLink).
 *
 * Agent-supplied URLs (restGet / buildUrl) are NOT guarded — the agent has
 * bash, so guarding them is theater. Scheme-blocking is redundant (undici
 * only fetches http:/https:). The secret-in-URL regex is omitted (host
 * doesn't handle secrets in v1).
 *
 * The guard becomes load-bearing when auth.kind:static-key / oauth2 ships:
 * at that point a server-supplied nextUrl to an internal host would leak
 * the Authorization header — textbook SSRF.
 */

// ─── Blocked hostnames ───────────────────────────────────────────────

const BLOCKED_HOSTNAMES = [
	"localhost",
	"127.0.0.1",
	"0.0.0.0",
	"169.254.169.254", // AWS/GCP metadata endpoint
	"metadata.google.internal",
	"100.100.100.200", // Alibaba Cloud metadata
];

/** Regex for internal IPv4: loopback (127.0.0.0/8), link-local (169.254.0.0/16), RFC1918 private (10.x, 172.16-31.x, 192.168.x) */
const INTERNAL_IP_REGEX =
	/^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

// ─── Guard ───────────────────────────────────────────────────────────

export function ssrfGuard(
	rawUrl: string,
): { ok: true } | { ok: false; reason: string } {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, reason: "Malformed URL" };
	}

	const hostname = parsed.hostname.toLowerCase();

	// Check against blocked hostname list (exact or subdomain match).
	for (const blocked of BLOCKED_HOSTNAMES) {
		if (hostname === blocked || hostname.endsWith("." + blocked)) {
			return {
				ok: false,
				reason: `Blocked hostname: ${hostname} (private/internal network)`,
			};
		}
	}

	// Check for internal IP ranges (loopback, link-local, private).
	if (INTERNAL_IP_REGEX.test(hostname)) {
		return {
			ok: false,
			reason: `Blocked IP range: ${hostname} (internal network)`,
		};
	}

	// Check IPv6. Node's URL.hostname INCLUDES brackets for IPv6 (e.g.
	// "[::1]", "[fe80::1]"), so strip them and match structurally — a
	// substring match on "::1" would also hit public addresses like
	// "2001:db8::1:2:3".
	const ipv6Inner = hostname.replace(/^\[|\]$/g, "");

	// Loopback is exactly ::1.
	if (ipv6Inner === "::1") {
		return {
			ok: false,
			reason: `Blocked IPv6 address: ${hostname} (loopback)`,
		};
	}

	// Link-local (fe80::/10 → first hextet fe80-febf) and unique-local
	// (fc00::/7 → first hextet fc00-fdff).
	if (/^(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/i.test(ipv6Inner)) {
		return {
			ok: false,
			reason: `Blocked IPv6 address: ${hostname} (link-local / unique-local)`,
		};
	}

	// IPv4-mapped IPv6 — the ::ffff: prefix marks the family. Node renders
	// these in HEX (e.g. "[::ffff:7f00:1]"), so a decimal string check is
	// silently dead. No legitimate public API serves nextLinks over
	// IPv4-mapped IPv6, so reject the whole family rather than decoding the
	// embedded IPv4. Match the prefix, not a substring — "::ffff:" can
	// also appear mid-address in a legit public IPv6 like "2001:db8::ffff:1".
	if (ipv6Inner.startsWith("::ffff:")) {
		return {
			ok: false,
			reason: `Blocked IPv4-mapped IPv6 address: ${hostname} (private/internal network)`,
		};
	}

	return { ok: true };
}
