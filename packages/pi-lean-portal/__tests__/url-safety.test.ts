import { expect } from "vitest";
import { validateUrl } from "../core/shared/url-safety.js";

// ─── Allowed URLs ──────────────────────────────────────────────

const allowedUrls = [
	["valid HTTPS URL", "https://example.com/page"] as const,
	["valid HTTP URL", "http://example.com/page"] as const,
	["HTTPS with port", "https://example.com:8443/api"] as const,
	[
		"URL with normal query params",
		"https://example.com/search?q=test&page=1",
	] as const,
] as Array<[string, string]>;

describe("Allowed URLs", () => {
	for (const [name, url] of allowedUrls) {
		it(`allows ${name}`, () => {
			const result = validateUrl(url);
			expect(result.safe).toBe(true);
		});
	}
});

// ─── SSRF: Blocked hostnames ──────────────────────────────────────

const ssrfHostnames = [
	["localhost", "http://localhost/admin"] as const,
	["localhost subdomain", "http://app.localhost/admin"] as const,
	["127.0.0.1", "http://127.0.0.1/test"] as const,
	["0.0.0.0", "http://0.0.0.0/metadata"] as const,
	["IPv6 loopback [::1]", "http://[::1]/admin"] as const,
	[
		"AWS metadata (169.254.169.254)",
		"http://169.254.169.254/latest/meta-data/",
	] as const,
	[
		"GCP metadata",
		"http://metadata.google.internal/computeMetadata/v1/",
	] as const,
	[
		"Alibaba Cloud metadata",
		"http://100.100.100.200/latest/meta-data/",
	] as const,
] as Array<[string, string]>;

describe("SSRF: Blocked hostnames", () => {
	for (const [name, url] of ssrfHostnames) {
		it(`blocks ${name}`, () => {
			const result = validateUrl(url);
			expect(result.safe).toBe(false);
			expect(result.category).toBe("ssrf");
		});
	}

	it("includes reason string for SSRF blocks", () => {
		const result = validateUrl("http://localhost/test");
		expect(result.reason).toMatch(/private|internal/i);
	});
});

// ─── SSRF: Private IP ranges ──────────────────────────────────

describe("SSRF: Private IP ranges", () => {
	it("blocks 10.0.0.0/8 range", () => {
		expect(validateUrl("http://10.0.0.1/internal").safe).toBe(false);
		expect(validateUrl("http://10.255.255.255/test").safe).toBe(false);
	});

	it("blocks 172.16.0.0/12 range", () => {
		expect(validateUrl("http://172.16.0.1/").safe).toBe(false);
		expect(validateUrl("http://172.31.255.255/").safe).toBe(false);
	});

	it("allows ranges outside 172.16-31", () => {
		expect(validateUrl("http://172.15.0.1/").safe).toBe(true);
		expect(validateUrl("http://172.32.0.1/").safe).toBe(true);
	});

	it("blocks 192.168.0.0/16 range", () => {
		const result = validateUrl("http://192.168.1.1/router");
		expect(result.safe).toBe(false);
		expect(result.category).toBe("ssrf");
	});
});

// ─── Blocked schemes ──────────────────────────────────────────

const blockedSchemes = [
	["file://", "file:///etc/passwd", "scheme"] as const,
	["ftp://", "ftp://example.com/file", "scheme"] as const,
	["data:", "data:text/html,<h1>test</h1>", "scheme"] as const,
	["javascript:", "javascript:alert(1)", "scheme"] as const,
	["vbscript:", "vbscript:MsgBox(1)", "scheme"] as const,
] as const;

type SchemeTuple = [string, string, string];

describe("Blocked schemes", () => {
	for (const [
		name,
		url,
		expectedCategory,
	] of blockedSchemes as unknown as readonly SchemeTuple[]) {
		it(`blocks ${name}`, () => {
			const result = validateUrl(url);
			expect(result.safe).toBe(false);
			expect(result.category).toBe(expectedCategory);
		});
	}

	it("includes reason string for scheme blocks", () => {
		const result = validateUrl("file:///etc/passwd");
		expect(result.reason).toBeTruthy();
	});
});

// ─── Secret detection ─────────────────────────────────────────

interface SecretCase {
	name: string;
	url: string;
}

const secretCases: SecretCase[] = [
	{ name: "api_key param", url: "https://example.com/api?api_key=secret123" },
	{ name: "token param", url: "https://example.com/auth?token=abc123" },
	{ name: "password param", url: "https://example.com/login?password=hunter2" },
	{ name: "secret param", url: "https://example.com/config?secret=mysecret" },
	{ name: "generic secret path", url: "https://example.com/secret/admin" },
	{
		name: "GitHub token (ghp_)",
		url: "https://api.github.com/repos?token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
	},
	{
		name: "Slack token (xoxb-)",
		url: "https://api.slack.com?token=xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUv",
	},
	{
		name: "Stripe secret key",
		url: "https://api.stripe.com?key=sk_live_1234567890abcdefghijklmn",
	},
	{
		name: "AWS access key (AKIA)",
		url: "https://example.com?aws_access_key_id=AKIAIOSFODNN7EXAMPLE",
	},
	{
		name: "Google API key",
		url: "https://www.googleapis.com?key=AIzaSyA1B2C3D4E5F6G7H8I9J0KlMnOpQrStUvW",
	},
];

describe("Secret detection", () => {
	for (const { name, url } of secretCases) {
		it(`blocks ${name}`, () => {
			const result = validateUrl(url);
			expect(result.safe).toBe(false);
		});

		it(`includes reason for ${name}`, () => {
			const result = validateUrl(url);
			expect(result.reason).toBeTruthy();
		});
	}

	it("detects percent-encoded secret param", () => {
		const result = validateUrl(
			"https://example.com/api?%61%70%69_key=testvalue",
		);
		expect(result.safe).toBe(false);
	});
});

// ─── Malformed URLs ────────────────────────────────────────────

describe("Malformed URLs", () => {
	it("rejects plain text string", () => {
		const result = validateUrl("not a url");
		expect(result.safe).toBe(false);
		expect(result.category).toBe("malformed");
	});

	it("rejects empty string", () => {
		const result = validateUrl("");
		expect(result.safe).toBe(false);
		expect(result.category).toBe("malformed");
	});
});
