/**
 * Managed-mode local_static handle rejection contract tests.
 *
 * Validates that the MANAGED_LOCAL_STATIC_REJECTION_ERROR constant used by
 * managed-main.ts contains the expected contract fragments. These tests
 * import the actual production constant (not a test-local copy), so they
 * will fail if the error message drifts away from the expected contract.
 */

import { describe, expect, test } from "bun:test";

import { HandleType, localStaticHandle, parseHandle } from "@vellumai/ces-contracts";

import { MANAGED_LOCAL_STATIC_REJECTION_ERROR } from "../managed-errors.js";

describe("managed-mode local_static rejection error", () => {
  test("error message references platform_oauth as the alternative", () => {
    expect(MANAGED_LOCAL_STATIC_REJECTION_ERROR).toContain("platform_oauth");
  });

  test("error message references managed mode", () => {
    expect(MANAGED_LOCAL_STATIC_REJECTION_ERROR).toContain("managed");
  });

  test("error message mentions local_static handles are not supported", () => {
    expect(MANAGED_LOCAL_STATIC_REJECTION_ERROR).toContain(
      "local_static credential handles are not supported",
    );
  });

  test("error message ends with a period", () => {
    expect(MANAGED_LOCAL_STATIC_REJECTION_ERROR).toMatch(/\.$/);
  });

  test("local_static handle is correctly identified for rejection", () => {
    const handle = localStaticHandle("github", "api_key");
    const result = parseHandle(handle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.type).toBe(HandleType.LocalStatic);
    }
  });
});
