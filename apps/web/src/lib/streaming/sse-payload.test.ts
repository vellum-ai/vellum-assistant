import { describe, expect, it } from "bun:test";

import { normalizeSSEPayload, toSseError } from "@/lib/streaming/sse-payload";

describe("normalizeSSEPayload", () => {
  it("returns object when given a Record", () => {
    const input = { type: "message", content: "hello" };
    expect(normalizeSSEPayload(input)).toEqual(input);
  });

  it("parses a JSON string into an object", () => {
    const input = JSON.stringify({ type: "status", status: "active" });
    expect(normalizeSSEPayload(input)).toEqual({
      type: "status",
      status: "active",
    });
  });

  it("returns null for invalid JSON string", () => {
    expect(normalizeSSEPayload("not json")).toBeNull();
  });

  it("returns null for JSON string that parses to null", () => {
    expect(normalizeSSEPayload("null")).toBeNull();
  });

  it("returns null for JSON string that parses to a number", () => {
    expect(normalizeSSEPayload("42")).toBeNull();
  });

  it("returns null for JSON string that parses to an array", () => {
    expect(normalizeSSEPayload("[1,2,3]")).toBeNull();
  });

  it("returns null for JSON string that parses to a boolean", () => {
    expect(normalizeSSEPayload("true")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeSSEPayload("")).toBeNull();
  });

  it("preserves nested objects", () => {
    const input = { meta: { nested: true }, items: [1, 2] };
    expect(normalizeSSEPayload(input)).toEqual(input);
  });

  it("returns null for a raw number (non-string, non-object)", () => {
    expect(normalizeSSEPayload(42 as unknown)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizeSSEPayload(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(normalizeSSEPayload(null)).toBeNull();
  });
});

describe("toSseError", () => {
  it("returns the error when given an Error instance", () => {
    const err = new Error("original");
    expect(toSseError(err, "fallback")).toBe(err);
  });

  it("wraps a string in an Error with the fallback message", () => {
    const result = toSseError("some string", "fallback message");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback message");
  });

  it("wraps undefined in an Error with the fallback message", () => {
    const result = toSseError(undefined, "fallback");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback");
  });

  it("wraps null in an Error with the fallback message", () => {
    const result = toSseError(null, "fallback");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback");
  });

  it("wraps a number in an Error with the fallback message", () => {
    const result = toSseError(404, "fallback");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("fallback");
  });

  it("preserves Error subclasses", () => {
    const err = new TypeError("type mismatch");
    expect(toSseError(err, "fallback")).toBe(err);
    expect(toSseError(err, "fallback")).toBeInstanceOf(TypeError);
  });
});
