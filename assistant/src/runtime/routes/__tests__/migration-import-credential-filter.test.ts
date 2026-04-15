/**
 * Tests for platform credential filtering during bundle import.
 *
 * The filtering logic in migration-routes.ts uses the PLATFORM_CREDENTIAL_PREFIX
 * constant ("vellum:") to exclude platform-identity credentials from being
 * written to the credential store during import. Since the filtering is a simple
 * array filter, we test the logic directly using the same prefix constant and
 * extractCredentialsFromBundle function — without needing to drive the full
 * HTTP handler (which has heavy transitive dependencies).
 *
 * Covers:
 * - vellum:* credentials are excluded when filtering with the prefix
 * - User credentials (without vellum: prefix) pass through unchanged
 * - Mixed bundles correctly split platform vs user credentials
 * - skippedPlatform count is accurate
 */

import { describe, expect, test } from "bun:test";

import { extractCredentialsFromBundle } from "../../migrations/vbundle-importer.js";
import type {
  ManifestType,
  VBundleTarEntry,
} from "../../migrations/vbundle-validator.js";

// ---------------------------------------------------------------------------
// The same constant used by migration-routes.ts
// ---------------------------------------------------------------------------

const PLATFORM_CREDENTIAL_PREFIX = "vellum:";

// ---------------------------------------------------------------------------
// Helpers (same pattern as vbundle-import-credentials.test.ts)
// ---------------------------------------------------------------------------

function makeTarEntry(data: string): VBundleTarEntry {
  const encoded = new TextEncoder().encode(data);
  return { name: "", data: encoded, size: encoded.length };
}

function makeManifest(paths: string[]): ManifestType {
  return {
    schema_version: "1.0.0",
    created_at: new Date().toISOString(),
    source: "test",
    manifest_sha256: "test",
    files: paths.map((path) => ({
      path,
      size: 0,
      sha256: "test",
    })),
  } as ManifestType;
}

/**
 * Simulate the filtering logic from migration-routes.ts:
 *
 *   const userCredentials = bundleCredentials.filter(
 *     (c) => !c.account.startsWith(PLATFORM_CREDENTIAL_PREFIX),
 *   );
 */
function filterCredentials(
  bundleCredentials: Array<{ account: string; value: string }>,
) {
  const userCredentials = bundleCredentials.filter(
    (c) => !c.account.startsWith(PLATFORM_CREDENTIAL_PREFIX),
  );
  const skippedPlatform = bundleCredentials.length - userCredentials.length;
  return { userCredentials, skippedPlatform };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migration import credential filtering", () => {
  test("vellum:-prefixed credentials are excluded", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set("credentials/vellum:assistant_api_key", makeTarEntry("key-1"));
    entries.set(
      "credentials/vellum:platform_assistant_id",
      makeTarEntry("asst-2"),
    );
    entries.set(
      "credentials/vellum:platform_base_url",
      makeTarEntry("https://example.com"),
    );
    entries.set(
      "credentials/vellum:platform_organization_id",
      makeTarEntry("org-3"),
    );
    entries.set("credentials/vellum:platform_user_id", makeTarEntry("user-4"));
    entries.set("credentials/vellum:webhook_secret", makeTarEntry("whsec-5"));

    const manifest = makeManifest([
      "credentials/vellum:assistant_api_key",
      "credentials/vellum:platform_assistant_id",
      "credentials/vellum:platform_base_url",
      "credentials/vellum:platform_organization_id",
      "credentials/vellum:platform_user_id",
      "credentials/vellum:webhook_secret",
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(userCredentials).toHaveLength(0);
    expect(skippedPlatform).toBe(6);
  });

  test("user credentials without vellum: prefix pass through unchanged", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set("credentials/openai-key", makeTarEntry("sk-user-123"));
    entries.set("credentials/anthropic-key", makeTarEntry("sk-ant-456"));

    const manifest = makeManifest([
      "credentials/openai-key",
      "credentials/anthropic-key",
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(userCredentials).toHaveLength(2);
    expect(userCredentials).toContainEqual({
      account: "openai-key",
      value: "sk-user-123",
    });
    expect(userCredentials).toContainEqual({
      account: "anthropic-key",
      value: "sk-ant-456",
    });
    expect(skippedPlatform).toBe(0);
  });

  test("mixed bundle with both vellum:* and user credentials correctly splits", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set(
      "credentials/vellum:assistant_api_key",
      makeTarEntry("platform-key"),
    );
    entries.set(
      "credentials/vellum:platform_user_id",
      makeTarEntry("platform-user"),
    );
    entries.set("credentials/openai-key", makeTarEntry("sk-user-123"));
    entries.set("credentials/anthropic-key", makeTarEntry("sk-ant-456"));
    entries.set("credentials/github-token", makeTarEntry("ghp-789"));

    const manifest = makeManifest([
      "credentials/vellum:assistant_api_key",
      "credentials/vellum:platform_user_id",
      "credentials/openai-key",
      "credentials/anthropic-key",
      "credentials/github-token",
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    // Only user credentials should pass through
    expect(userCredentials).toHaveLength(3);
    const accounts = userCredentials.map((c) => c.account).sort();
    expect(accounts).toEqual(["anthropic-key", "github-token", "openai-key"]);

    // No vellum: credentials in the filtered output
    const vellumCreds = userCredentials.filter((c) =>
      c.account.startsWith("vellum:"),
    );
    expect(vellumCreds).toHaveLength(0);

    expect(skippedPlatform).toBe(2);
  });

  test("skippedPlatform count is accurate with mixed credentials", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set("credentials/vellum:assistant_api_key", makeTarEntry("v1"));
    entries.set("credentials/vellum:platform_base_url", makeTarEntry("v2"));
    entries.set("credentials/vellum:webhook_secret", makeTarEntry("v3"));
    entries.set("credentials/user-key", makeTarEntry("user-val"));

    const manifest = makeManifest([
      "credentials/vellum:assistant_api_key",
      "credentials/vellum:platform_base_url",
      "credentials/vellum:webhook_secret",
      "credentials/user-key",
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(skippedPlatform).toBe(3);
    expect(userCredentials).toHaveLength(1);
    expect(userCredentials[0]).toEqual({
      account: "user-key",
      value: "user-val",
    });

    // Verify total = user + skipped
    expect(bundleCredentials.length).toBe(
      userCredentials.length + skippedPlatform,
    );
  });
});
