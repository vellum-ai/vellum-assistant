/**
 * Tests for `getOriginMode` — the vbundle manifest `origin.mode` derivation.
 *
 * Covers:
 * - `IS_PLATFORM=true` → "managed" (wins over IS_CONTAINERIZED).
 * - `IS_CONTAINERIZED=true` (no IS_PLATFORM) → "self-hosted-remote".
 * - Neither → "self-hosted-local".
 * - Regression: a logged-in local assistant holding managed-proxy
 *   credentials (platform URL + assistant_api_key) must NOT be classified
 *   "managed". Since the managed-on-login work every logged-in local has
 *   those credentials, and a "managed" stamp trips the importer's
 *   `secrets_redacted must be true when origin.mode is 'managed'` refine,
 *   breaking local→platform teleport. The helper therefore keys on the
 *   IS_PLATFORM deployment env only — nothing here consults the credential
 *   store, so the regression case is simply "no env flags set".
 */

import { afterEach, describe, expect, test } from "bun:test";

import { getOriginMode } from "../origin-mode.js";

const ORIGINAL_IS_PLATFORM = process.env.IS_PLATFORM;
const ORIGINAL_IS_CONTAINERIZED = process.env.IS_CONTAINERIZED;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restore("IS_PLATFORM", ORIGINAL_IS_PLATFORM);
  restore("IS_CONTAINERIZED", ORIGINAL_IS_CONTAINERIZED);
});

describe("getOriginMode", () => {
  test("IS_PLATFORM=true → managed", async () => {
    process.env.IS_PLATFORM = "true";
    delete process.env.IS_CONTAINERIZED;
    expect(await getOriginMode()).toBe("managed");
  });

  test("IS_PLATFORM wins over IS_CONTAINERIZED", async () => {
    process.env.IS_PLATFORM = "1";
    process.env.IS_CONTAINERIZED = "true";
    expect(await getOriginMode()).toBe("managed");
  });

  test("IS_CONTAINERIZED=true without IS_PLATFORM → self-hosted-remote", async () => {
    delete process.env.IS_PLATFORM;
    process.env.IS_CONTAINERIZED = "true";
    expect(await getOriginMode()).toBe("self-hosted-remote");
  });

  test("neither flag → self-hosted-local (incl. logged-in locals with managed-proxy creds)", async () => {
    delete process.env.IS_PLATFORM;
    delete process.env.IS_CONTAINERIZED;
    expect(await getOriginMode()).toBe("self-hosted-local");
  });
});
