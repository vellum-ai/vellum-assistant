import { describe, expect, mock, test } from "bun:test";

const captureExceptionMock = mock(
  (_error: unknown, _opts?: Record<string, unknown>) => "event-id",
);

mock.module("@sentry/react", () => ({
  captureException: captureExceptionMock,
}));

const { captureError, normalizeToError } = await import(
  "@/lib/sentry/capture-error"
);

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
});
