import { describe, test, expect } from "bun:test";

import { parseConfirmArgs } from "../commands/confirm.js";

describe("parseConfirmArgs", () => {
  test("parses a request id with the active assistant and defaults to allow", () => {
    const r = parseConfirmArgs(["--request-id", "req-1"]);
    expect(r).toEqual({
      ok: true,
      value: {
        assistantId: undefined,
        requestId: "req-1",
        decision: "allow",
        jsonOutput: false,
      },
    });
  });

  test("parses an explicit assistant plus request id", () => {
    const r = parseConfirmArgs(["my-assistant", "--request-id", "req-1"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.assistantId).toBe("my-assistant");
    expect(r.value.requestId).toBe("req-1");
  });

  test("honors an explicit deny decision", () => {
    const r = parseConfirmArgs(["--request-id", "req-1", "--decision", "deny"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision).toBe("deny");
  });

  test("requires a request id", () => {
    const r = parseConfirmArgs([]);
    expect(r).toEqual({ ok: false, error: "--request-id is required." });
  });

  test("rejects an unknown decision", () => {
    const r = parseConfirmArgs([
      "--request-id",
      "req-1",
      "--decision",
      "maybe",
    ]);
    expect(r).toEqual({
      ok: false,
      error: '--decision must be "allow" or "deny" (got "maybe").',
    });
  });

  test("rejects a value-less --decision instead of defaulting to allow", () => {
    // A trailing `--decision` with no value (e.g. an empty shell expansion)
    // must not silently approve via the "allow" default.
    const r = parseConfirmArgs(["--request-id", "req-1", "--decision"]);
    expect(r).toEqual({
      ok: false,
      error: '--decision requires a value ("allow" or "deny").',
    });
  });

  test("rejects an empty-string --decision value", () => {
    const r = parseConfirmArgs(["--request-id", "req-1", "--decision", ""]);
    expect(r).toEqual({
      ok: false,
      error: '--decision must be "allow" or "deny" (got "").',
    });
  });

  test("rejects a value-less --request-id", () => {
    const r = parseConfirmArgs(["--request-id"]);
    expect(r).toEqual({
      ok: false,
      error: "--request-id requires a value.",
    });
  });

  test("preserves --json alongside the request id", () => {
    const r = parseConfirmArgs(["--json", "--request-id", "req-1"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.jsonOutput).toBe(true);
    expect(r.value.requestId).toBe("req-1");
  });
});
