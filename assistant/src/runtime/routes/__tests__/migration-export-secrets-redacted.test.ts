/**
 * Unit tests for `computeSecretsRedacted`.
 *
 * The helper decides whether the v1 manifest may truthfully claim
 * `secrets_redacted: true`. Three signals feed in:
 *   - credentialCount: number of credentials actually included in the bundle.
 *   - storeUnreachable: top-level `listSecureKeysAsync()` failed — we never
 *     enumerated the accounts.
 *   - perAccountUnreachable: enumeration succeeded, but at least one
 *     `getSecureKeyResultAsync(account)` returned `unreachable: true`. Those
 *     accounts were silently skipped from the credentials array, so a zero
 *     count could be hiding real secrets we just couldn't read.
 *
 * Only the all-clear case (zero credentials, both flags false) may return
 * true. Any failure mode forces false — claiming a clean redaction in those
 * cases would lie about what's in the bundle.
 */

import { describe, expect, test } from "bun:test";

import { computeSecretsRedacted } from "../migration-routes.js";

describe("computeSecretsRedacted", () => {
  test("genuinely empty store + reachable + no per-account failures → true", () => {
    expect(computeSecretsRedacted(0, false, false)).toBe(true);
  });

  test("top-level store unreachable → false (couldn't read at all)", () => {
    expect(computeSecretsRedacted(0, true, false)).toBe(false);
  });

  test("per-account read failure → false (partial read failure)", () => {
    expect(computeSecretsRedacted(0, false, true)).toBe(false);
  });

  test("both top-level and per-account failures → false", () => {
    expect(computeSecretsRedacted(0, true, true)).toBe(false);
  });

  test("credentials included + no failures → false (creds in bundle)", () => {
    expect(computeSecretsRedacted(3, false, false)).toBe(false);
  });

  test("credentials included + per-account failure → false (creds + partial failure)", () => {
    expect(computeSecretsRedacted(3, false, true)).toBe(false);
  });

  test("credentials included + store unreachable → false", () => {
    // Defensive: in practice `storeUnreachable` implies zero credentials,
    // but the helper should still behave correctly if a caller passes a
    // non-zero count alongside an unreachable flag.
    expect(computeSecretsRedacted(3, true, false)).toBe(false);
  });
});
