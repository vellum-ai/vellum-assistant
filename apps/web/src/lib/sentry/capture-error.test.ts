import { describe, expect, mock, test } from "bun:test";

const captureExceptionMock = mock(
  (_error: unknown, _opts?: Record<string, unknown>) => "event-id",
);

mock.module("@sentry/react", () => ({
  captureException: captureExceptionMock,
}));

const { captureError, normalizeToError, isExpectedDaemonTransientError } =
  await import("@/lib/sentry/capture-error");
const { ApiError } = await import("@/utils/api-errors");

describe("normalizeToError", () => {
  test("returns Error instances unchanged", () => {
    const err = new Error("original");
    expect(normalizeToError(err)).toBe(err);
  });

  test("wraps object with `detail` string", () => {
    const raw = { detail: "Your assistant is still starting up." };
    const result = normalizeToError(raw);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Your assistant is still starting up.");
    expect(result.cause).toBe(raw);
  });

  test("wraps object with `message` string", () => {
    const raw = { message: "Something went wrong", code: 500 };
    const result = normalizeToError(raw);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Something went wrong");
    expect(result.cause).toBe(raw);
  });

  test("prefers `detail` over `message` when both are present", () => {
    const raw = { detail: "detail wins", message: "message loses" };
    const result = normalizeToError(raw);
    expect(result.message).toBe("detail wins");
  });

  test("falls back to JSON.stringify for unknown object shapes", () => {
    const raw = { code: 503, status: "unavailable" };
    const result = normalizeToError(raw);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(JSON.stringify(raw));
    expect(result.cause).toBe(raw);
  });

  test("handles non-serializable objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = normalizeToError(circular);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Non-serializable error object");
    expect(result.cause).toBe(circular);
  });

  test("wraps string values", () => {
    const result = normalizeToError("string error");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("string error");
  });

  test("wraps null", () => {
    const result = normalizeToError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("null");
  });

  test("wraps undefined", () => {
    const result = normalizeToError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("undefined");
  });
});

describe("captureError", () => {
  test("passes normalized Error to Sentry with originalError extra", () => {
    captureExceptionMock.mockClear();
    const raw = { detail: "still starting up" };
    captureError(raw, { context: "test-ctx" });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [captured, opts] = captureExceptionMock.mock.calls[0]!;
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("still starting up");
    expect((opts as Record<string, unknown>).tags).toEqual({
      context: "test-ctx",
    });
    expect(
      ((opts as Record<string, unknown>).extra as Record<string, unknown>)
        .originalError,
    ).toBe(raw);
  });

  test("passes Error instances directly without originalError extra", () => {
    captureExceptionMock.mockClear();
    const err = new Error("real error");
    captureError(err, { context: "test-ctx" });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [captured, opts] = captureExceptionMock.mock.calls[0]!;
    expect(captured).toBe(err);
    expect(opts).not.toHaveProperty("extra");
  });

  test("silently drops transient network errors", () => {
    captureExceptionMock.mockClear();
    captureError(new TypeError("Failed to fetch"), { context: "test-ctx" });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("reports daemon transient errors without bestEffort flag", () => {
    captureExceptionMock.mockClear();
    captureError(new ApiError(503, "Your assistant is still starting up."), {
      context: "test-ctx",
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  test("silently drops daemon transient errors with bestEffort flag", () => {
    captureExceptionMock.mockClear();
    captureError(new ApiError(503, "Your assistant is still starting up."), {
      context: "test-ctx",
      bestEffort: true,
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("reports unexpected ApiError even with bestEffort flag", () => {
    captureExceptionMock.mockClear();
    captureError(new ApiError(500, "Internal Server Error"), {
      context: "test-ctx",
      bestEffort: true,
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

describe("isExpectedDaemonTransientError", () => {
  test("returns true for 503 daemon starting up", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(503, "Your assistant is still starting up."),
      ),
    ).toBe(true);
  });

  test("returns true for 502 bad gateway", () => {
    expect(
      isExpectedDaemonTransientError(new ApiError(502, "Bad gateway")),
    ).toBe(true);
  });

  test("returns true for 401 auth race", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(401, "Authentication credentials were not provided."),
      ),
    ).toBe(true);
  });

  test("returns true for 400 org-header missing", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(400, "Vellum-Organization-Id header is required."),
      ),
    ).toBe(true);
  });

  test("returns false for 400 without org-header message", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(400, "Invalid request body."),
      ),
    ).toBe(false);
  });

  test("returns false for 500 internal server error", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(500, "Internal Server Error"),
      ),
    ).toBe(false);
  });

  test("returns false for non-ApiError Error instances", () => {
    expect(isExpectedDaemonTransientError(new Error("random error"))).toBe(
      false,
    );
    expect(
      isExpectedDaemonTransientError(new TypeError("Failed to fetch")),
    ).toBe(false);
  });

  test("returns false for primitives and null", () => {
    expect(isExpectedDaemonTransientError("string error")).toBe(false);
    expect(isExpectedDaemonTransientError(null)).toBe(false);
    expect(isExpectedDaemonTransientError(undefined)).toBe(false);
    expect(isExpectedDaemonTransientError(42)).toBe(false);
  });

  // HeyAPI throwOnError throws raw JSON response bodies ({detail: "..."})
  // without wrapping in ApiError. These tests verify detection of the raw
  // Django REST framework error shape.
  test("returns true for raw {detail} with 503 startup message", () => {
    expect(
      isExpectedDaemonTransientError({
        detail: "Your assistant is still starting up. Please try again in a moment.",
      }),
    ).toBe(true);
  });

  test("returns true for raw {detail} with org-header message", () => {
    expect(
      isExpectedDaemonTransientError({
        detail: "Vellum-Organization-Id header is required.",
      }),
    ).toBe(true);
  });

  test("returns true for raw {detail} with 401 auth message", () => {
    expect(
      isExpectedDaemonTransientError({
        detail: "Authentication credentials were not provided.",
      }),
    ).toBe(true);
  });

  test("returns true for raw {detail} with bad gateway message", () => {
    expect(
      isExpectedDaemonTransientError({ detail: "Bad gateway" }),
    ).toBe(true);
    expect(
      isExpectedDaemonTransientError({ detail: "Bad Gateway" }),
    ).toBe(true);
  });

  test("returns false for raw {detail} with unknown message", () => {
    expect(
      isExpectedDaemonTransientError({ detail: "Internal Server Error" }),
    ).toBe(false);
    expect(
      isExpectedDaemonTransientError({ detail: "Permission denied." }),
    ).toBe(false);
  });

  test("returns false for raw object without detail field", () => {
    expect(
      isExpectedDaemonTransientError({ message: "something" }),
    ).toBe(false);
    expect(isExpectedDaemonTransientError({})).toBe(false);
  });

  test("returns false for raw {detail} with non-string value", () => {
    expect(
      isExpectedDaemonTransientError({ detail: 503 }),
    ).toBe(false);
    expect(
      isExpectedDaemonTransientError({ detail: ["error1", "error2"] }),
    ).toBe(false);
  });
});

describe("captureError with bestEffort and raw HeyAPI errors", () => {
  test("silently drops raw {detail} daemon transient errors with bestEffort", () => {
    captureExceptionMock.mockClear();
    captureError(
      { detail: "Your assistant is still starting up. Please try again in a moment." },
      { context: "test-ctx", bestEffort: true },
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("reports raw {detail} daemon transient errors without bestEffort", () => {
    captureExceptionMock.mockClear();
    captureError(
      { detail: "Your assistant is still starting up." },
      { context: "test-ctx" },
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  test("reports raw {detail} with unknown message even with bestEffort", () => {
    captureExceptionMock.mockClear();
    captureError(
      { detail: "Internal Server Error" },
      { context: "test-ctx", bestEffort: true },
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
