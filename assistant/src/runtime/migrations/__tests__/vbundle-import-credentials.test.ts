/**
 * Tests for credential import from vbundle archives.
 *
 * Covers:
 * - extractCredentialsFromBundle() correctly extracts credential entries
 * - DefaultPathResolver skips credentials/ paths (not written to disk)
 * - Empty and missing credential entries are handled gracefully
 */

import { describe, expect, test } from "bun:test";

import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { extractCredentialsFromBundle } from "../vbundle-importer.js";
import type { ManifestType, VBundleTarEntry } from "../vbundle-validator.js";

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// extractCredentialsFromBundle
// ---------------------------------------------------------------------------

describe("extractCredentialsFromBundle", () => {
  test("extracts credential entries from tar entries map", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set("credentials/openai-key", makeTarEntry("sk-test-123"));
    entries.set("credentials/anthropic-key", makeTarEntry("sk-ant-456"));
    entries.set("workspace/config.json", makeTarEntry('{"test": true}'));
    entries.set("manifest.json", makeTarEntry("{}"));

    const manifest = makeManifest([
      "credentials/openai-key",
      "credentials/anthropic-key",
      "workspace/config.json",
    ]);
    const credentials = extractCredentialsFromBundle(entries, manifest);

    expect(credentials).toHaveLength(2);
    expect(credentials).toContainEqual({
      account: "openai-key",
      value: "sk-test-123",
    });
    expect(credentials).toContainEqual({
      account: "anthropic-key",
      value: "sk-ant-456",
    });
  });

  test("returns empty array when no credential entries exist", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set("workspace/config.json", makeTarEntry('{"test": true}'));
    entries.set("manifest.json", makeTarEntry("{}"));

    const manifest = makeManifest(["workspace/config.json"]);
    const credentials = extractCredentialsFromBundle(entries, manifest);

    expect(credentials).toHaveLength(0);
  });

  test("returns empty array for empty entries map", () => {
    const entries = new Map<string, VBundleTarEntry>();

    const manifest = makeManifest([]);
    const credentials = extractCredentialsFromBundle(entries, manifest);

    expect(credentials).toHaveLength(0);
  });

  test("skips bare credentials/ path with no account name", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set("credentials/", makeTarEntry("some-value"));
    entries.set("credentials/valid-key", makeTarEntry("valid-secret"));

    const manifest = makeManifest(["credentials/", "credentials/valid-key"]);
    const credentials = extractCredentialsFromBundle(entries, manifest);

    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual({
      account: "valid-key",
      value: "valid-secret",
    });
  });

  test("ignores credential entries not declared in manifest", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set("credentials/declared-key", makeTarEntry("declared-secret"));
    entries.set(
      "credentials/undeclared-key",
      makeTarEntry("undeclared-secret"),
    );

    const manifest = makeManifest(["credentials/declared-key"]);
    const credentials = extractCredentialsFromBundle(entries, manifest);

    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual({
      account: "declared-key",
      value: "declared-secret",
    });
  });

  test("handles credential values with special characters", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set(
      "credentials/complex-key",
      makeTarEntry("value with spaces & special=chars!"),
    );

    const manifest = makeManifest(["credentials/complex-key"]);
    const credentials = extractCredentialsFromBundle(entries, manifest);

    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual({
      account: "complex-key",
      value: "value with spaces & special=chars!",
    });
  });

  test("extracts vellum:-prefixed credentials (filtering happens in migration-routes)", () => {
    const entries = new Map<string, VBundleTarEntry>();
    entries.set(
      "credentials/vellum:assistant_api_key",
      makeTarEntry("key-123"),
    );
    entries.set(
      "credentials/vellum:platform_assistant_id",
      makeTarEntry("asst-456"),
    );
    entries.set("credentials/openai-key", makeTarEntry("sk-user-789"));

    const manifest = makeManifest([
      "credentials/vellum:assistant_api_key",
      "credentials/vellum:platform_assistant_id",
      "credentials/openai-key",
    ]);
    const credentials = extractCredentialsFromBundle(entries, manifest);

    // extractCredentialsFromBundle does NOT filter — it returns all credentials.
    // Filtering of vellum:* platform credentials is done in migration-routes.ts.
    expect(credentials).toHaveLength(3);
    expect(credentials).toContainEqual({
      account: "vellum:assistant_api_key",
      value: "key-123",
    });
    expect(credentials).toContainEqual({
      account: "vellum:platform_assistant_id",
      value: "asst-456",
    });
    expect(credentials).toContainEqual({
      account: "openai-key",
      value: "sk-user-789",
    });
  });
});

// ---------------------------------------------------------------------------
// DefaultPathResolver — credential path skipping
// ---------------------------------------------------------------------------

describe("DefaultPathResolver skips credential paths", () => {
  test("resolve() returns null for credentials/ paths", () => {
    const resolver = new DefaultPathResolver("/tmp/workspace", "/tmp/hooks");

    expect(resolver.resolve("credentials/openai-key")).toBeNull();
    expect(resolver.resolve("credentials/anthropic-key")).toBeNull();
    expect(resolver.resolve("credentials/")).toBeNull();
  });

  test("resolve() still resolves non-credential paths normally", () => {
    const resolver = new DefaultPathResolver("/tmp/workspace", "/tmp/hooks");

    // workspace/ paths should resolve
    expect(resolver.resolve("workspace/config.json")).not.toBeNull();

    // data/db should resolve
    expect(resolver.resolve("data/db/assistant.db")).not.toBeNull();
  });
});
