import { describe, expect, test } from "bun:test";

import { isTransientNetworkError } from "@/utils/is-transient-network-error";

describe("isTransientNetworkError", () => {
  test("matches Chrome/Safari 'Failed to fetch'", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(
      true,
    );
  });

  test("matches older Safari 'Load failed'", () => {
    expect(isTransientNetworkError(new TypeError("Load failed"))).toBe(true);
  });

  test("matches Firefox 'NetworkError when attempting to fetch resource'", () => {
    expect(
      isTransientNetworkError(
        new TypeError("NetworkError when attempting to fetch resource"),
      ),
    ).toBe(true);
  });

  test("rejects non-TypeError errors", () => {
    expect(isTransientNetworkError(new Error("Failed to fetch"))).toBe(false);
  });

  test("rejects TypeError with different message", () => {
    expect(
      isTransientNetworkError(new TypeError("Cannot read properties of null")),
    ).toBe(false);
  });

  test("rejects non-error values", () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError("Failed to fetch")).toBe(false);
  });

  test("rejects substring matches (not exact)", () => {
    expect(
      isTransientNetworkError(
        new TypeError("Failed to fetch dynamically imported module"),
      ),
    ).toBe(false);
  });
});
