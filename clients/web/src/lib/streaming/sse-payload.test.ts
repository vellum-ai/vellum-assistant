import { describe, expect, test } from "bun:test";

import { normalizeSSEPayload, unwrapMessageEnvelope } from "@/lib/streaming/sse-payload";

// ---------------------------------------------------------------------------
// normalizeSSEPayload
// ---------------------------------------------------------------------------

describe("normalizeSSEPayload", () => {
  test("returns object payloads as-is", () => {
    const obj = { type: "event", data: "hello" };
    expect(normalizeSSEPayload(obj)).toBe(obj);
  });

  test("parses JSON string payloads", () => {
    const result = normalizeSSEPayload('{"type":"event","data":"hello"}');
    expect(result).toEqual({ type: "event", data: "hello" });
  });

  test("returns null for non-JSON strings", () => {
    expect(normalizeSSEPayload("not json")).toBeNull();
  });

  test("returns null for JSON array strings", () => {
    expect(normalizeSSEPayload("[1,2,3]")).toBeNull();
  });

  test("returns null for JSON primitive strings", () => {
    expect(normalizeSSEPayload('"just a string"')).toBeNull();
    expect(normalizeSSEPayload("42")).toBeNull();
    expect(normalizeSSEPayload("null")).toBeNull();
    expect(normalizeSSEPayload("true")).toBeNull();
  });

  test("returns null for array payloads", () => {
    expect(normalizeSSEPayload([1, 2, 3] as unknown as Record<string, unknown>)).toBeNull();
  });

  test("returns null for null/undefined", () => {
    expect(normalizeSSEPayload(null)).toBeNull();
    expect(normalizeSSEPayload(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unwrapMessageEnvelope
// ---------------------------------------------------------------------------

describe("unwrapMessageEnvelope", () => {
  test("unwraps envelope with .message object", () => {
    const inner = { seq: 1, data: "hello" };
    const envelope = { message: inner };
    expect(unwrapMessageEnvelope(envelope)).toBe(inner);
  });

  test("returns raw when .message is absent", () => {
    const raw = { seq: 1, data: "hello" };
    expect(unwrapMessageEnvelope(raw)).toBe(raw);
  });

  test("returns raw when .message is a string", () => {
    const raw = { message: "not an object", other: true };
    expect(unwrapMessageEnvelope(raw)).toBe(raw);
  });

  test("returns raw when .message is an array", () => {
    const raw = { message: [1, 2, 3] };
    expect(unwrapMessageEnvelope(raw)).toBe(raw);
  });

  test("returns raw when .message is null", () => {
    const raw = { message: null };
    expect(unwrapMessageEnvelope(raw)).toBe(raw);
  });
});
