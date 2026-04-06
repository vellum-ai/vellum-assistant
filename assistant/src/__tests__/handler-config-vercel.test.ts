import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { noopLogger } from "./handlers/handler-test-helpers.js";

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

const mockUpsertCredentialMetadata = mock(() => ({}));
const mockDeleteCredentialMetadata = mock(() => true);
mock.module("../tools/credentials/metadata-store.js", () => ({
  upsertCredentialMetadata: mockUpsertCredentialMetadata,
  deleteCredentialMetadata: mockDeleteCredentialMetadata,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  deleteVercelConfig,
  getVercelConfig,
  setVercelConfig,
} from "../daemon/handlers/config-vercel.js";
import { credentialKey } from "../security/credential-key.js";
import { _setStorePath } from "../security/encrypted-store.js";
import {
  _resetBackend,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";

// ── Setup ───────────────────────────────────────────────────────────────────

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const secureStorePath = join(testDir, "vercel-keys.enc");
const originalVellumDev = process.env.VELLUM_DEV;

// Force dev backend (file-based encrypted store, no macOS Keychain)
process.env.VELLUM_DEV = "1";

afterAll(() => {
  _setStorePath(null);
  _resetBackend();
  if (originalVellumDev === undefined) {
    delete process.env.VELLUM_DEV;
  } else {
    process.env.VELLUM_DEV = originalVellumDev;
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Vercel config handler", () => {
  beforeEach(() => {
    rmSync(secureStorePath, { force: true });
    _setStorePath(secureStorePath);
    _resetBackend();
    mockUpsertCredentialMetadata.mockClear();
    mockDeleteCredentialMetadata.mockClear();
  });

  test("getVercelConfig returns hasToken: false when no token stored", async () => {
    const result = await getVercelConfig();
    expect(result).toEqual({ hasToken: false, success: true });
  });

  test("getVercelConfig returns hasToken: true when token exists", async () => {
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "vl_test_token_123",
    );

    const result = await getVercelConfig();
    expect(result).toEqual({ hasToken: true, success: true });
  });

  test("setVercelConfig stores token and returns success", async () => {
    const result = await setVercelConfig("vl_test_token_abc");

    expect(result).toEqual({ hasToken: true, success: true });

    // Verify the token was actually stored
    const stored = await getSecureKeyAsync(
      credentialKey("vercel", "api_token"),
    );
    expect(stored).toBe("vl_test_token_abc");
  });

  test("setVercelConfig writes credential metadata with allowedTools", async () => {
    await setVercelConfig("vl_test_token_meta");

    expect(mockUpsertCredentialMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertCredentialMetadata).toHaveBeenCalledWith(
      "vercel",
      "api_token",
      { allowedTools: ["deploy", "publish_page"] },
    );
  });

  test("setVercelConfig with undefined token returns error", async () => {
    const result = await setVercelConfig(undefined);

    expect(result).toEqual({
      hasToken: false,
      success: false,
      error: "apiToken is required",
    });
  });

  test("deleteVercelConfig removes token and returns success", async () => {
    // Store a token first
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "vl_to_delete",
    );

    const result = await deleteVercelConfig();

    expect(result).toEqual({ hasToken: false, success: true });

    // Verify the token was actually removed
    const stored = await getSecureKeyAsync(
      credentialKey("vercel", "api_token"),
    );
    expect(stored).toBeUndefined();
  });

  test("deleteVercelConfig calls deleteCredentialMetadata", async () => {
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "vl_to_delete",
    );

    await deleteVercelConfig();

    expect(mockDeleteCredentialMetadata).toHaveBeenCalledTimes(1);
    expect(mockDeleteCredentialMetadata).toHaveBeenCalledWith(
      "vercel",
      "api_token",
    );
  });

  test("deleteVercelConfig when no token exists still succeeds", async () => {
    const result = await deleteVercelConfig();
    expect(result).toEqual({ hasToken: false, success: true });
  });
});
