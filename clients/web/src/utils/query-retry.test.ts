import { describe, expect, test } from "bun:test";

const { httpStatusFromError, shouldRetryQuery, queryRetryDelay } = await import(
  "@/utils/query-retry"
);
const { ApiError } = await import("@/utils/api-errors");

describe("httpStatusFromError", () => {
  test("reads ApiError.status", () => {
    expect(httpStatusFromError(new ApiError(429, "rate limited"))).toBe(429);
  });

  test("reads a numeric status field", () => {
    expect(httpStatusFromError({ status: 503 })).toBe(503);
  });

  test("reads response.status", () => {
    expect(httpStatusFromError({ response: { status: 502 } })).toBe(502);
  });

  test("returns undefined for network/non-HTTP errors", () => {
    expect(httpStatusFromError(new TypeError("Failed to fetch"))).toBeUndefined();
    expect(httpStatusFromError("boom")).toBeUndefined();
  });
});

describe("shouldRetryQuery", () => {
  test("never retries 429 (the storm trigger)", () => {
    expect(shouldRetryQuery(0, new ApiError(429, "rate limited"))).toBe(false);
  });

  test("never retries other 4xx client errors", () => {
    expect(shouldRetryQuery(0, new ApiError(401, "unauthorized"))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(404, "not found"))).toBe(false);
  });

  test("retries transient 5xx", () => {
    expect(shouldRetryQuery(0, new ApiError(503, "starting"))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError(502, "bad gateway"))).toBe(true);
  });

  test("retries network errors (no status)", () => {
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  });

  test("stops after 3 failures regardless of error", () => {
    expect(shouldRetryQuery(3, new ApiError(503, "starting"))).toBe(false);
    expect(shouldRetryQuery(3, new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  test("capped exponential backoff", () => {
    expect(queryRetryDelay(0)).toBe(1000);
    expect(queryRetryDelay(1)).toBe(2000);
    expect(queryRetryDelay(2)).toBe(4000);
    expect(queryRetryDelay(10)).toBe(30_000); // capped
  });
});
