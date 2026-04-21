import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger before importing any code that uses it.
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { _setStorePath } from "../encrypted-store.js";
import { _resetBackend, getProviderKeyAsync } from "../secure-keys.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-provkey-envfallback-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

/**
 * Regression test for the env-var fallback in `getProviderKeyAsync`.
 *
 * PR #27126 introduced `getLlmProviderEnvVar` which is LLM-scoped only.
 * After that PR, calls like `getProviderKeyAsync("brave")` and
 * `getProviderKeyAsync("perplexity")` stopped resolving the env var when
 * the secure store was empty, breaking web-search for users with
 * env-var-sourced Brave/Perplexity keys. The fix (this PR) routes the
 * fallback through `getAnyProviderEnvVar` which consults both the LLM
 * catalog and the search-provider map.
 */
describe("getProviderKeyAsync env-var fallback (regression #27126)", () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  const MANAGED_VARS = [
    "BRAVE_API_KEY",
    "PERPLEXITY_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ];

  beforeEach(() => {
    // Fresh encrypted store (no saved credentials → forces env-var fallback).
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
    _resetBackend();

    // Snapshot env so each test starts clean.
    for (const name of MANAGED_VARS) {
      SAVED_ENV[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    _setStorePath(null);
    _resetBackend();
    for (const name of MANAGED_VARS) {
      const saved = SAVED_ENV[name];
      if (saved === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved;
      }
    }
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("returns BRAVE_API_KEY from process.env when secure store is empty", async () => {
    process.env.BRAVE_API_KEY = "brave-env-test";
    expect(await getProviderKeyAsync("brave")).toBe("brave-env-test");
  });

  test("returns PERPLEXITY_API_KEY from process.env when secure store is empty", async () => {
    process.env.PERPLEXITY_API_KEY = "pplx-env-test";
    expect(await getProviderKeyAsync("perplexity")).toBe("pplx-env-test");
  });

  test("returns ANTHROPIC_API_KEY from process.env when secure store is empty (LLM regression)", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-env-test";
    expect(await getProviderKeyAsync("anthropic")).toBe("anthropic-env-test");
  });

  test("returns OPENAI_API_KEY from process.env when secure store is empty (LLM regression)", async () => {
    process.env.OPENAI_API_KEY = "openai-env-test";
    expect(await getProviderKeyAsync("openai")).toBe("openai-env-test");
  });

  test("returns undefined for unknown provider even if any env var is set", async () => {
    process.env.BRAVE_API_KEY = "brave-env-test";
    expect(await getProviderKeyAsync("unknown-provider")).toBeUndefined();
  });

  test("returns undefined for keyless ollama even if env has unrelated keys", async () => {
    process.env.BRAVE_API_KEY = "brave-env-test";
    expect(await getProviderKeyAsync("ollama")).toBeUndefined();
  });
});
