import { verifyShipManifest } from "./core/shared/ship-manifest.js";
import { describe, expect, it } from "vitest";

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module across the tree", () => {
		expect(
			verifyShipManifest(import.meta.url, { skipDirs: ["contributed"] })
				.missing,
		).toEqual([]);
	});

	it("every `files` entry points at something on disk — a stale entry ships nothing", () => {
		expect(
			verifyShipManifest(import.meta.url, { skipDirs: ["contributed"] }).stale,
		).toEqual([]);
	});
});
