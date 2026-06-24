/**
 * Contract tests for the MockPlugin — validates that the contract
 * test harness itself works correctly against a known-good fixture.
 *
 * These tests exercise the structural (non-browser) contract only.
 * Real-browser behavioral tests run in chromium-py.test.ts (Phase B6).
 */

import { runContractTests } from "./helpers/plugin-contract.js";
import { MockPlugin } from "./helpers/mock-plugin.js";

runContractTests("mock", () => new MockPlugin());
