/**
 * Plugin secret-pattern registry: restricted-grammar validation, per-plugin
 * replace/unregister semantics, version counter, and union memoization.
 *
 * Also guards the module's import-light invariant — hot-path consumers
 * (`util/log-redact.ts`, used inside log serializers) import the registry, so
 * it must import nothing beyond `secret-patterns` types and `re2js`.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getPluginSecretPatterns,
  getPluginSecretPatternsVersion,
  registerPluginSecretPatterns,
  resetPluginSecretPatternsForTests,
  unregisterPluginSecretPatterns,
} from "../security/plugin-secret-patterns.js";

const VALID_PATTERN = "virlo_tkn_[A-Za-z0-9_-]{20,}";

describe("plugin secret-pattern registry", () => {
  beforeEach(() => {
    resetPluginSecretPatternsForTests();
  });

  afterEach(() => {
    resetPluginSecretPatternsForTests();
  });

  test("a well-formed anchored prefix pattern registers and is exposed with a namespaced label", () => {
    const result = registerPluginSecretPatterns("virlo", [
      { label: "Virlo API Key", pattern: VALID_PATTERN },
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([]);

    const union = getPluginSecretPatterns();
    expect(union.length).toBe(1);
    expect(union[0]!.label).toBe("Virlo API Key (plugin:virlo)");
    expect(union[0]!.regex).toBeInstanceOf(RegExp);
    expect(union[0]!.regex.flags).toBe("");
    expect(union[0]!.regex.test(`virlo_tkn_${"a".repeat(24)}`)).toBe(true);
    expect(union[0]!.regex.test("unrelated text")).toBe(false);
  });

  describe("restricted grammar rejections", () => {
    const cases: Array<{ name: string; pattern: string }> = [
      { name: "over-broad .*", pattern: ".*" },
      { name: "ReDoS-shaped (a+)+b", pattern: "(a+)+b" },
      { name: "prefix-less \\w{10,}", pattern: "\\w{10,}" },
      {
        name: "oversized 300-char source",
        pattern: `virlo_tkn_${"a".repeat(290)}`,
      },
      {
        name: "capture group",
        pattern: "virlo_tkn_([A-Za-z0-9_-]{20,})",
      },
      { name: "lookahead", pattern: "virlo_tkn_(?=[A-Za-z0-9]{20,})" },
    ];

    for (const { name, pattern } of cases) {
      test(`rejects ${name} with a reason and leaves the registry unchanged`, () => {
        const result = registerPluginSecretPatterns("virlo", [
          { label: "Bad Pattern", pattern },
        ]);
        expect(result.accepted).toBe(0);
        expect(result.rejected.length).toBe(1);
        expect(result.rejected[0]!.pattern).toBe(pattern);
        expect(result.rejected[0]!.reason.length).toBeGreaterThan(0);
        expect(getPluginSecretPatterns()).toEqual([]);
      });
    }

    test("rejects a label longer than 40 chars", () => {
      const result = registerPluginSecretPatterns("virlo", [
        { label: "x".repeat(41), pattern: VALID_PATTERN },
      ]);
      expect(result.accepted).toBe(0);
      expect(result.rejected[0]!.reason).toMatch(/label/);
    });

    test("a 6-pattern batch accepts 5 and rejects the excess", () => {
      const batch = Array.from({ length: 6 }, (_, i) => ({
        label: `Key ${i}`,
        pattern: `virlo_tkn_${i}_[A-Za-z0-9]{20,}`,
      }));
      const result = registerPluginSecretPatterns("virlo", batch);
      expect(result.accepted).toBe(5);
      expect(result.rejected.length).toBe(1);
      expect(result.rejected[0]!.reason).toMatch(/limit/);
      expect(getPluginSecretPatterns().length).toBe(5);
    });

    test("a mixed batch accepts valid entries and rejects invalid ones independently", () => {
      const result = registerPluginSecretPatterns("virlo", [
        { label: "Good", pattern: VALID_PATTERN },
        { label: "Bad", pattern: ".*" },
      ]);
      expect(result.accepted).toBe(1);
      expect(result.rejected.length).toBe(1);
      expect(getPluginSecretPatterns().map((p) => p.label)).toEqual([
        "Good (plugin:virlo)",
      ]);
    });
  });

  describe("registry lifecycle", () => {
    test("re-registering the same plugin replaces its prior set, not appends", () => {
      registerPluginSecretPatterns("virlo", [
        { label: "Old Key", pattern: VALID_PATTERN },
      ]);
      registerPluginSecretPatterns("virlo", [
        { label: "New Key", pattern: "virlo_sec_[A-Za-z0-9]{20,}" },
      ]);
      const union = getPluginSecretPatterns();
      expect(union.length).toBe(1);
      expect(union[0]!.label).toBe("New Key (plugin:virlo)");
    });

    test("unregister removes the plugin's patterns", () => {
      registerPluginSecretPatterns("virlo", [
        { label: "Virlo API Key", pattern: VALID_PATTERN },
      ]);
      registerPluginSecretPatterns("other", [
        { label: "Other Key", pattern: "othr_key_[A-Za-z0-9]{20,}" },
      ]);
      unregisterPluginSecretPatterns("virlo");
      expect(getPluginSecretPatterns().map((p) => p.label)).toEqual([
        "Other Key (plugin:other)",
      ]);
    });

    test("version bumps on every mutation and not on reads", () => {
      const v0 = getPluginSecretPatternsVersion();
      registerPluginSecretPatterns("virlo", [
        { label: "Virlo API Key", pattern: VALID_PATTERN },
      ]);
      const v1 = getPluginSecretPatternsVersion();
      expect(v1).toBeGreaterThan(v0);

      getPluginSecretPatterns();
      expect(getPluginSecretPatternsVersion()).toBe(v1);

      registerPluginSecretPatterns("virlo", [
        { label: "Virlo API Key", pattern: VALID_PATTERN },
      ]);
      const v2 = getPluginSecretPatternsVersion();
      expect(v2).toBeGreaterThan(v1);

      unregisterPluginSecretPatterns("virlo");
      const v3 = getPluginSecretPatternsVersion();
      expect(v3).toBeGreaterThan(v2);

      // Unregistering a plugin that never registered is not a mutation.
      unregisterPluginSecretPatterns("never-registered");
      expect(getPluginSecretPatternsVersion()).toBe(v3);
    });

    test("the union is referentially stable between mutations", () => {
      registerPluginSecretPatterns("virlo", [
        { label: "Virlo API Key", pattern: VALID_PATTERN },
      ]);
      const first = getPluginSecretPatterns();
      expect(getPluginSecretPatterns()).toBe(first);

      registerPluginSecretPatterns("other", [
        { label: "Other Key", pattern: "othr_key_[A-Za-z0-9]{20,}" },
      ]);
      const second = getPluginSecretPatterns();
      expect(second).not.toBe(first);
      expect(getPluginSecretPatterns()).toBe(second);
    });
  });

  test("import-light invariant: only re2js and secret-patterns types are imported", () => {
    const source = readFileSync(
      new URL("../security/plugin-secret-patterns.ts", import.meta.url),
      "utf-8",
    );
    const imports = [...source.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports).toEqual([
      'import { RE2JS } from "re2js";',
      'import type { SecretPrefixPattern } from "./secret-patterns.js";',
    ]);
  });
});
