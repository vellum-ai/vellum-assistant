import { describe, expect, test } from "bun:test";

import { CancelledError } from "@tanstack/react-query";

import { isCancellationError } from "@/utils/is-cancellation-error";

describe("isCancellationError", () => {
  test("matches TanStack Query CancelledError", () => {
    expect(isCancellationError(new CancelledError())).toBe(true);
    expect(isCancellationError(new CancelledError({ silent: true }))).toBe(
      true,
    );
    expect(isCancellationError(new CancelledError({ revert: true }))).toBe(
      true,
    );
  });

  test("matches AbortError DOMExceptions in every engine wording", () => {
    for (const message of [
      "signal is aborted without reason",
      "The user aborted a request.",
      "The operation was aborted.",
      "Fetch is aborted",
    ]) {
      expect(isCancellationError(new DOMException(message, "AbortError"))).toBe(
        true,
      );
    }
  });

  test("matches WKWebView-style plain objects carrying the AbortError name", () => {
    expect(isCancellationError({ name: "AbortError" })).toBe(true);
  });

  test("does not match genuine timeouts", () => {
    expect(
      isCancellationError(new DOMException("Timed out", "TimeoutError")),
    ).toBe(false);
  });

  test("does not match ordinary errors or non-errors", () => {
    expect(isCancellationError(new Error("CancelledError"))).toBe(false);
    expect(isCancellationError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isCancellationError(null)).toBe(false);
    expect(isCancellationError(undefined)).toBe(false);
    expect(isCancellationError("AbortError")).toBe(false);
    expect(isCancellationError({ name: "SomethingElse" })).toBe(false);
  });
});
