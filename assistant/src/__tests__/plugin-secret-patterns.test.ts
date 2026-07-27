/**
 * Plugin secret-pattern registry: restricted-grammar validation, per-plugin
 * replace/unregister semantics, and union memoization (identity-based —
 * consumers invalidate via `memoizePluginPatternDerivation`).
 *
 * Also guards the module's import-light invariant — hot-path consumers
 * (`util/log-redact.ts`, used inside log serializers) import the registry, so
 * it must import nothing beyond `secret-patterns` types and `re2js`.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getPluginSecretPatterns,
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

  test("a pattern guaranteeing exactly the minimum match length (4 literal + {12}) is accepted", () => {
    const result = registerPluginSecretPatterns("acme", [
      { label: "Acme Key", pattern: "abcd[0-9]{12}" },
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(getPluginSecretPatterns()[0]!.regex.test("abcd012345678901")).toBe(
      true,
    );
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
      // A literal prefix followed by an alternation branch that matches
      // everything — the branch bypasses the prefix requirement.
      { name: "alternation bypass virlo|.*", pattern: "virlo|.*" },
      // Compiles under RE2 but backtracks catastrophically under the native
      // engine the stored matcher runs on.
      { name: "quantified group (?:a+)+", pattern: "virlo_(?:a+)+b" },
      {
        name: "nested (lazy) quantifier {4,}?",
        pattern: "virlo_tkn_[A-Za-z0-9]{4,}?",
      },
      // Guaranteed match is only 4 chars — would flag every occurrence of
      // "http" in ordinary text.
      { name: "too-short guaranteed match", pattern: "http" },
      // Multi-character escapes span several source characters per matched
      // character, so the min-match-length arithmetic would overcount them
      // (`abcd\x41\x41\x41\x41` scores 16 but guarantees only 8).
      { name: "hex escape \\xNN", pattern: "abcd\\x41\\x41\\x41\\x41" },
      {
        name: "unicode escape \\uNNNN",
        pattern: "abcd\\u0041\\u0041\\u0041\\u0041",
      },
      { name: "control escape \\cX", pattern: "abcd\\cA[A-Za-z0-9]{20,}" },
      { name: "NUL escape \\0", pattern: "abcd\\0[A-Za-z0-9]{20,}" },
      {
        name: "hex escape inside a character class",
        pattern: "abcd[\\x41-\\x5A]{20,}",
      },
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

    test("rejects a multi-char escape with the escape reason, not the length reason", () => {
      // The pattern's naive atom count (16) satisfies the length floor, so a
      // length-based rejection would prove the overcount is still reachable.
      const result = registerPluginSecretPatterns("virlo", [
        { label: "Hex Key", pattern: "abcd\\x41\\x41\\x41\\x41" },
      ]);
      expect(result.accepted).toBe(0);
      expect(result.rejected[0]!.reason).toContain(
        "hex/unicode/control escapes are not allowed",
      );
      expect(result.rejected[0]!.reason).not.toContain("16 characters");
    });

    test("an escaped dot stays legal (virlo\\.tkn_[a-z]{10})", () => {
      const result = registerPluginSecretPatterns("virlo", [
        { label: "Dotted Key", pattern: "virlo\\.tkn_[a-z]{10}" },
      ]);
      expect(result.accepted).toBe(1);
      expect(result.rejected).toEqual([]);
      const union = getPluginSecretPatterns();
      expect(union[0]!.regex.test("virlo.tkn_abcdefghij")).toBe(true);
      expect(union[0]!.regex.test("virloxtkn_abcdefghij")).toBe(false);
    });

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

    test("the union is referentially stable between mutations and changes identity on each one", () => {
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

      unregisterPluginSecretPatterns("other");
      const third = getPluginSecretPatterns();
      expect(third).not.toBe(second);

      // Unregistering a plugin that never registered is not a mutation —
      // downstream memoized derivations must not be invalidated.
      unregisterPluginSecretPatterns("never-registered");
      expect(getPluginSecretPatterns()).toBe(third);
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
