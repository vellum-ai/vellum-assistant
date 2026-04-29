/**
 * Tests for platform credential filtering during bundle import.
 *
 * `migration-routes.ts` pushes every bundle credential through a filter that
 * must exclude platform-identity (`vellum:*`) entries so they can't overwrite
 * the target's own Django-provisioned identity. The filter runs against the
 * raw CES account format — `credential/{service}/{field}` — produced by
 * `credentialKey()`, which is what `listSecureKeysAsync()` returns and what
 * `extractCredentialsFromBundle` surfaces back as `account`.
 *
 * The constant is duplicated here (rather than imported) because
 * `migration-routes.ts` has heavy transitive imports that are expensive to
 * resolve in a test and would require wide mocking. Instead we bind the two
 * copies with a regression assertion: if `credentialKey()`'s output format
 * changes, the `startsWith(...)` prefix must change in lockstep. That
 * regression is explicit at the bottom of this file.
 *
 * Covered:
 * - Platform (vellum:*) credentials stored under the real `credential/vellum/...`
 *   key format are excluded.
 * - User credentials (any other prefix) pass through unchanged.
 * - Mixed bundles correctly split platform vs user credentials.
 * - skippedPlatform count matches the number of excluded entries.
 * - Regression: the prefix constant matches `credentialKey("vellum", "")`.
 */

import { describe, expect, test } from "bun:test";

import { credentialKey } from "../../../security/credential-key.js";
import { extractCredentialsFromBundle } from "../../migrations/vbundle-importer.js";
import type {
  ManifestType,
  VBundleTarEntry,
} from "../../migrations/vbundle-validator.js";

// ---------------------------------------------------------------------------
// The same constant used by migration-routes.ts — kept in sync via the
// regression assertion at the bottom of this file.
// ---------------------------------------------------------------------------

const PLATFORM_CREDENTIAL_PREFIX = credentialKey("vellum", "");

// ---------------------------------------------------------------------------
// Helpers (same pattern as vbundle-import-credentials.test.ts)
// ---------------------------------------------------------------------------

function makeTarEntry(data: string): VBundleTarEntry {
  const encoded = new TextEncoder().encode(data);
  return { name: "", data: encoded, size: encoded.length };
}

function makeManifest(paths: string[]): ManifestType {
  return {
    schema_version: 1,
    bundle_id: "00000000-0000-4000-8000-000000000000",
    created_at: new Date().toISOString(),
    assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
    origin: { mode: "self-hosted-local" },
    compatibility: {
      min_runtime_version: "0.0.0-test",
      max_runtime_version: null,
    },
    contents: paths.map((path) => ({
      path,
      size_bytes: 0,
      sha256: "test",
    })),
    checksum:
      "0000000000000000000000000000000000000000000000000000000000000000",
    secrets_redacted: false,
    export_options: {
      include_logs: false,
      include_browser_state: false,
      include_memory_vectors: false,
    },
  } as unknown as ManifestType;
}

/**
 * Build a bundle archive entry path for a credential whose CES account is
 * `account`. `vbundle-builder.ts` stores credentials under
 * `credentials/<account>`; the importer reverses that split.
 */
function bundlePathFor(account: string): string {
  return `credentials/${account}`;
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
  test("platform (vellum:*) credentials are excluded", () => {
    const vellumFields = [
      "assistant_api_key",
      "platform_assistant_id",
      "platform_base_url",
      "platform_organization_id",
      "platform_user_id",
      "webhook_secret",
    ] as const;
    const vellumPaths = vellumFields.map((f) =>
      bundlePathFor(credentialKey("vellum", f)),
    );

    const entries = new Map<string, VBundleTarEntry>();
    for (const path of vellumPaths) {
      entries.set(path, makeTarEntry(`value-for-${path}`));
    }

    const manifest = makeManifest(vellumPaths);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(userCredentials).toHaveLength(0);
    expect(skippedPlatform).toBe(vellumFields.length);
  });

  test("user credentials pass through unchanged", () => {
    const openaiAccount = credentialKey("openai", "api_key");
    const anthropicAccount = credentialKey("anthropic", "api_key");

    const entries = new Map<string, VBundleTarEntry>();
    entries.set(bundlePathFor(openaiAccount), makeTarEntry("sk-user-123"));
    entries.set(bundlePathFor(anthropicAccount), makeTarEntry("sk-ant-456"));

    const manifest = makeManifest([
      bundlePathFor(openaiAccount),
      bundlePathFor(anthropicAccount),
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(userCredentials).toHaveLength(2);
    expect(userCredentials).toContainEqual({
      account: openaiAccount,
      value: "sk-user-123",
    });
    expect(userCredentials).toContainEqual({
      account: anthropicAccount,
      value: "sk-ant-456",
    });
    expect(skippedPlatform).toBe(0);
  });

  test("mixed bundle with both platform and user credentials correctly splits", () => {
    const vellumApiKey = credentialKey("vellum", "assistant_api_key");
    const vellumUserId = credentialKey("vellum", "platform_user_id");
    const openaiKey = credentialKey("openai", "api_key");
    const anthropicKey = credentialKey("anthropic", "api_key");
    const githubToken = credentialKey("github", "api_token");

    const entries = new Map<string, VBundleTarEntry>();
    entries.set(bundlePathFor(vellumApiKey), makeTarEntry("platform-key"));
    entries.set(bundlePathFor(vellumUserId), makeTarEntry("platform-user"));
    entries.set(bundlePathFor(openaiKey), makeTarEntry("sk-user-123"));
    entries.set(bundlePathFor(anthropicKey), makeTarEntry("sk-ant-456"));
    entries.set(bundlePathFor(githubToken), makeTarEntry("ghp-789"));

    const manifest = makeManifest([
      bundlePathFor(vellumApiKey),
      bundlePathFor(vellumUserId),
      bundlePathFor(openaiKey),
      bundlePathFor(anthropicKey),
      bundlePathFor(githubToken),
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    // Only user credentials should pass through.
    expect(userCredentials).toHaveLength(3);
    const accounts = userCredentials.map((c) => c.account).sort();
    expect(accounts).toEqual([anthropicKey, githubToken, openaiKey].sort());

    // No platform credentials in the filtered output.
    const vellumCreds = userCredentials.filter((c) =>
      c.account.startsWith(PLATFORM_CREDENTIAL_PREFIX),
    );
    expect(vellumCreds).toHaveLength(0);

    expect(skippedPlatform).toBe(2);
  });

  test("skippedPlatform count is accurate with mixed credentials", () => {
    const vellumApiKey = credentialKey("vellum", "assistant_api_key");
    const vellumBaseUrl = credentialKey("vellum", "platform_base_url");
    const vellumWebhook = credentialKey("vellum", "webhook_secret");
    const userKey = credentialKey("github", "api_token");

    const entries = new Map<string, VBundleTarEntry>();
    entries.set(bundlePathFor(vellumApiKey), makeTarEntry("v1"));
    entries.set(bundlePathFor(vellumBaseUrl), makeTarEntry("v2"));
    entries.set(bundlePathFor(vellumWebhook), makeTarEntry("v3"));
    entries.set(bundlePathFor(userKey), makeTarEntry("user-val"));

    const manifest = makeManifest([
      bundlePathFor(vellumApiKey),
      bundlePathFor(vellumBaseUrl),
      bundlePathFor(vellumWebhook),
      bundlePathFor(userKey),
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(skippedPlatform).toBe(3);
    expect(userCredentials).toHaveLength(1);
    expect(userCredentials[0]).toEqual({
      account: userKey,
      value: "user-val",
    });

    // Verify total = user + skipped
    expect(bundleCredentials.length).toBe(
      userCredentials.length + skippedPlatform,
    );
  });

  test("regression: the prefix matches credentialKey('vellum', '') so format changes propagate", () => {
    // If credentialKey()'s format ever changes (e.g. slash → something else),
    // this assertion will fail and the duplicated constant in
    // migration-routes.ts must be updated to stay in sync.
    expect(PLATFORM_CREDENTIAL_PREFIX).toBe("credential/vellum/");
    expect(
      credentialKey("vellum", "assistant_api_key").startsWith(
        PLATFORM_CREDENTIAL_PREFIX,
      ),
    ).toBe(true);

    // The raw "vellum:" string is not a valid CES account prefix — only
    // the full "credential/vellum/" format from credentialKey() is correct.
    expect(
      credentialKey("vellum", "assistant_api_key").startsWith("vellum:"),
    ).toBe(false);
  });
});
