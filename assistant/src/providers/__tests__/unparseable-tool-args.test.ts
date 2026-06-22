import { describe, expect, test } from "bun:test";

import {
  isUnparseableToolArgs,
  unparseableToolArgsMessage,
  wrapUnparseableToolArgs,
} from "../unparseable-tool-args.js";

describe("unparseable tool args marker", () => {
  test("wrap/detect roundtrip", () => {
    const wrapped = wrapUnparseableToolArgs(
      '{"surface_type": "card", "data": ',
    );
    expect(isUnparseableToolArgs(wrapped)).toBe(true);
  });

  test("detects empty raw string", () => {
    expect(isUnparseableToolArgs(wrapUnparseableToolArgs(""))).toBe(true);
  });

  test("does not match input with additional keys", () => {
    expect(isUnparseableToolArgs({ _raw: "x", other: 1 })).toBe(false);
  });

  test("does not match non-string _raw", () => {
    expect(isUnparseableToolArgs({ _raw: { nested: true } })).toBe(false);
  });

  test("does not match ordinary tool input", () => {
    expect(isUnparseableToolArgs({ command: "ls" })).toBe(false);
    expect(isUnparseableToolArgs({})).toBe(false);
  });

  test("message includes tool name, raw preview, and retry instruction", () => {
    const msg = unparseableToolArgsMessage("ui_show", '{"surface_type": ');
    expect(msg).toContain('"ui_show"');
    expect(msg).toContain('{"surface_type": ');
    expect(msg).toContain("NOT executed");
    expect(msg).toContain("Retry");
  });

  test("message truncates long raw args", () => {
    const raw = "a".repeat(1000);
    const msg = unparseableToolArgsMessage("bash", raw);
    expect(msg).not.toContain(raw);
    expect(msg).toContain("a".repeat(200) + "…");
  });

  test("message handles empty raw args", () => {
    const msg = unparseableToolArgsMessage("bash", "");
    expect(msg).toContain("(empty)");
  });
});
