/**
 * Tests for the pure helpers behind `assistant memory retrospective run`'s
 * rewind flags: the `--from` / `--from-start` resolver and the cursor
 * formatter. The command's action wiring is exercised end-to-end by the
 * retrospective job tests plus manual CLI runs; these cover the flag
 * semantics that gate the overrideCursor replay path.
 */

import { describe, expect, mock, test } from "bun:test";

const noop = () => {};
const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop };
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => fakeLogger,
  getCliLogger: () => fakeLogger,
}));

const { describeCursor, resolveRunCursorOverride } =
  await import("../memory-retrospective.js");

describe("resolveRunCursorOverride", () => {
  test("neither flag: default (persisted cursor is used)", () => {
    expect(resolveRunCursorOverride({})).toEqual({ kind: "default" });
  });

  test("--from-start resolves to a null override (replay from the beginning)", () => {
    expect(resolveRunCursorOverride({ fromStart: true })).toEqual({
      kind: "override",
      overrideCursor: null,
    });
  });

  test("--from <messageId> resolves to that id as the override", () => {
    expect(resolveRunCursorOverride({ from: "msg-123" })).toEqual({
      kind: "override",
      overrideCursor: "msg-123",
    });
  });

  test("--from and --from-start together are rejected", () => {
    const result = resolveRunCursorOverride({
      from: "msg-123",
      fromStart: true,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("mutually exclusive");
    }
  });

  test("an empty --from value is rejected with a pointer to --from-start", () => {
    const result = resolveRunCursorOverride({ from: "" });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("--from-start");
    }
  });

  test("fromStart: false behaves as absent", () => {
    expect(resolveRunCursorOverride({ fromStart: false })).toEqual({
      kind: "default",
    });
    expect(
      resolveRunCursorOverride({ from: "msg-123", fromStart: false }),
    ).toEqual({ kind: "override", overrideCursor: "msg-123" });
  });
});

describe("describeCursor", () => {
  test("null and the empty-string sentinel render as the start of the conversation", () => {
    expect(describeCursor(null)).toBe("(start of conversation)");
    expect(describeCursor("")).toBe("(start of conversation)");
  });

  test("a concrete message id renders verbatim", () => {
    expect(describeCursor("msg-123")).toBe("msg-123");
  });
});
