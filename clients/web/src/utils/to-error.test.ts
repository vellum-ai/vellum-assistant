import { describe, expect, test } from "bun:test";

import { toError } from "@/utils/to-error";

describe("toError", () => {
  test("returns Error instances as-is", () => {
    const err = new Error("original");
    expect(toError(err, "fallback")).toBe(err);
  });

  test("returns Error subclasses as-is", () => {
    const err = new TypeError("type issue");
    expect(toError(err, "fallback")).toBe(err);
    expect(toError(err, "fallback")).toBeInstanceOf(TypeError);
  });

  test("wraps string with fallback message", () => {
    const result = toError("some string", "fallback message");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback message");
  });

  test("wraps undefined with fallback message", () => {
    const result = toError(undefined, "fallback");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback");
  });

  test("wraps null with fallback message", () => {
    const result = toError(null, "fallback");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback");
  });

  test("wraps number with fallback message", () => {
    const result = toError(404, "fallback");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback");
  });

  test("wraps object with fallback message", () => {
    const result = toError({ code: 500 }, "fallback");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback");
  });
});
