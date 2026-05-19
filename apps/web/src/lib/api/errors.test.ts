import { describe, expect, test } from "bun:test";

import { toErrorObject, extractErrorMessage } from "@/lib/api/errors.js";

describe("toErrorObject", () => {
  test("returns object errors as-is", () => {
    const error = { detail: "something went wrong" };
    expect(toErrorObject(error)).toBe(error);
  });

  test("wraps normal string errors as { detail }", () => {
    expect(toErrorObject("bad request")).toEqual({ detail: "bad request" });
  });

  test("skips HTML strings starting with <", () => {
    const html = "<html><body>502 Bad Gateway</body></html>";
    expect(toErrorObject(html)).toEqual({ detail: "Request failed." });
  });

  test("skips HTML strings with leading whitespace before <", () => {
    const html = "  <html><body>Error</body></html>";
    expect(toErrorObject(html)).toEqual({ detail: "Request failed." });
  });

  test("uses response.statusText when HTML string is skipped", () => {
    const html = "<html>error</html>";
    const response = { statusText: "Bad Gateway" } as Response;
    expect(toErrorObject(html, response)).toEqual({ detail: "Bad Gateway" });
  });

  test("uses response.statusText for empty string errors", () => {
    const response = { statusText: "Not Found" } as Response;
    expect(toErrorObject("", response)).toEqual({ detail: "Not Found" });
  });

  test("falls back to generic message for non-object non-string errors", () => {
    expect(toErrorObject(null)).toEqual({ detail: "Request failed." });
    expect(toErrorObject(undefined)).toEqual({ detail: "Request failed." });
    expect(toErrorObject(42)).toEqual({ detail: "Request failed." });
  });

  test("truncates long string errors to 500 characters", () => {
    const long = "x".repeat(600);
    const result = toErrorObject(long);
    expect((result.detail as string).length).toBe(500);
  });
});

describe("extractErrorMessage", () => {
  test("extracts detail field from object errors", () => {
    expect(extractErrorMessage({ detail: "not found" })).toBe("not found");
  });

  test("extracts error field from object errors", () => {
    expect(extractErrorMessage({ error: "unauthorized" })).toBe(
      "unauthorized",
    );
  });

  test("extracts error.message from nested object errors", () => {
    expect(
      extractErrorMessage({ error: { message: "rate limited" } }),
    ).toBe("rate limited");
  });

  test("extracts message field from object errors", () => {
    expect(extractErrorMessage({ message: "server error" })).toBe(
      "server error",
    );
  });

  test("returns normal string errors directly", () => {
    expect(extractErrorMessage("something broke")).toBe("something broke");
  });

  test("skips HTML strings and uses fallback", () => {
    expect(extractErrorMessage("<html>502</html>")).toBe("Request failed.");
  });

  test("skips HTML strings and uses explicit fallback", () => {
    expect(
      extractErrorMessage("<html>502</html>", undefined, "custom fallback"),
    ).toBe("custom fallback");
  });

  test("skips HTML strings and uses response status", () => {
    const response = { status: 502 } as Response;
    expect(extractErrorMessage("<html>error</html>", response)).toBe(
      "HTTP 502",
    );
  });

  test("uses fallback for null/undefined errors", () => {
    expect(extractErrorMessage(null, undefined, "oops")).toBe("oops");
    expect(extractErrorMessage(undefined, undefined, "oops")).toBe("oops");
  });

  test("falls back to HTTP status when no fallback provided", () => {
    const response = { status: 500 } as Response;
    expect(extractErrorMessage(null, response)).toBe("HTTP 500");
  });

  test("falls back to generic message with no response or fallback", () => {
    expect(extractErrorMessage(null)).toBe("Request failed.");
  });
});
