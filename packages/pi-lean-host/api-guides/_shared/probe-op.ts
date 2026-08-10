/**
 * Interactive op probe — exercise a live operation through the REAL executor
 * (`restGet` / `paginate` from `core/helpers.js`) without writing a guide.
 *
 * Reads the guide from the REPO's `api-guides/<domain>/guide.md` (the file the
 * rollout edits), resolves the named operation, and runs it against the live
 * endpoint — printing the actual request URLs (incl. every pagination page)
 * and the parsed result. This is how an agent verifies a candidate op (via,
 * itemsPath, pagination style, params) before committing the YAML, and — for
 * #14 services.dnb.de — directly inspects the per-page URLs to confirm or
 * refute the strict-OAI `resumptionToken` risk in the rollout doc.
 *
 * Dev tooling, not shipped (api-guides/ is excluded from the npm tarball).
 *
 * Usage:
 *   npx tsx packages/pi-lean-host/api-guides/_shared/probe-op.ts <domain> <operation> \
 *     [--params '{"owner":"octocat","per_page":30}'] [--gatherAll]
 *
 * `--gatherAll` walks every page (paginate ops only); default is a single page.
 */

import {
	setUserGuidesDir,
	invalidateCache,
	findGuidesByDomain,
} from "../../core/guide-store.js";
import { restGet, paginate } from "../../core/helpers.js";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const _dirname = dirname(fileURLToPath(import.meta.url));
// _shared/ lives one level under api-guides/, so the guides root is its parent.
const REPO_API_GUIDES = join(_dirname, "..");

function trunc(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}\n…` : s;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const domain = args[0];
	const operation = args[1];
	if (!domain || !operation) {
		console.log(
			"usage: npx tsx api-guides/_shared/probe-op.ts <domain> <operation> " +
				"[--params '{\"k\":v}'] [--gatherAll]",
		);
		process.exit(1);
	}
	const gatherAll = args.includes("--gatherAll");
	let params: Record<string, unknown> = {};
	const pi = args.indexOf("--params");
	if (pi !== -1 && args[pi + 1]) {
		try {
			params = JSON.parse(args[pi + 1]!);
		} catch {
			console.log(`--params must be valid JSON: ${args[pi + 1]}`);
			process.exit(1);
		}
	}

	setUserGuidesDir(REPO_API_GUIDES);
	invalidateCache();

	const guide = findGuidesByDomain(domain)[0]?.guide;
	if (!guide) {
		console.log(`no guide for '${domain}' under ${REPO_API_GUIDES}`);
		process.exit(1);
	}
	const op = guide.operations.find((o) => o.name === operation);
	if (!op) {
		console.log(
			`no operation '${operation}' in '${domain}' (have: ${guide.operations
				.map((o) => o.name)
				.join(", ")})`,
		);
		process.exit(1);
	}

	console.log(`🔬 ${domain} › ${operation} · ${guide.apiHost}${op.path}`);
	try {
		if (op.via === "paginate") {
			const r = await paginate(guide.apiHost, op, params, guide, {
				gatherAll,
			});
			const lines = [
				`  via: paginate · ${r.pages} page(s) · ${r.totalFetched} item(s)` +
					(r.ceilingHit ? " · CEILING" : "") +
					(r.serverTotal !== undefined
						? ` · serverTotal: ${r.serverTotal}`
						: ""),
			];
			r.urls.forEach((u, i) => lines.push(`  url[${i}]: ${u}`));
			lines.push(`  items: ${trunc(JSON.stringify(r.items), 2000)}`);
			console.log(lines.join("\n"));
		} else {
			const r = await restGet(guide.apiHost, op, params, guide);
			console.log(`  via: restGet`);
			console.log(`  url: ${r.url}`);
			console.log(`  data: ${trunc(JSON.stringify(r.data, null, 2), 2000)}`);
		}
	} catch (err) {
		console.log(
			`probe FAILED: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
