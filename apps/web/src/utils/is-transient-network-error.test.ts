import { describe, expect, test } from "bun:test";

import { isTransientNetworkError } from "@/utils/is-transient-network-error";

describe("isTransientNetworkError", () => {
  test("matches Chrome/Safari 'Failed to fetch'", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(
      true,
    );
  });

  test("matches 'Failed to fetch' with hostname suffix (Sentry enrichment)", () => {
    expect(
      isTransientNetworkError(
        new TypeError("Failed to fetch (www.vellum.ai)"),
      ),
    ).toBe(true);
    expect(
      isTransientNetworkError(
        new TypeError("Failed to fetch (example.com)"),
      ),
    ).toBe(true);
  });

  test("matches older Safari 'Load failed'", () => {
    expect(isTransientNetworkError(new TypeError("Load failed"))).toBe(true);
  });

  test("matches 'Load failed' with hostname suffix", () => {
    expect(
      isTransientNetworkError(new TypeError("Load failed (example.com)")),
    ).toBe(true);
  });

  test("matches Firefox 'NetworkError when attempting to fetch resource'", () => {
    expect(
      isTransientNetworkError(
        new TypeError("NetworkError when attempting to fetch resource"),
      ),
    ).toBe(true);
  });

  test("matches Firefox variant with trailing dot", () => {
    expect(
      isTransientNetworkError(
        new TypeError("NetworkError when attempting to fetch resource."),
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

  test("rejects dynamic import failures (not transient network errors)", () => {
    expect(
      isTransientNetworkError(
        new TypeError("Failed to fetch dynamically imported module"),
      ),
    ).toBe(false);
    expect(
      isTransientNetworkError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://example.com/chunk.js",
        ),
      ),
    ).toBe(false);
  });

  test("rejects fetch-like messages that aren't network errors", () => {
    expect(
      isTransientNetworkError(new TypeError("Failed to fetch user profile")),
    ).toBe(false);
  });
});
