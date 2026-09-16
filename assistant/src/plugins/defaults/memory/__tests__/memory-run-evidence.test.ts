/**
 * Tests for `memory-run-evidence.ts`: the readers of what a background
 * memory run durably produced, shared by the retrospective's cursor advance
 * and consolidation's buffer consumption.
 */

import { describe, expect, test } from "bun:test";

import {
  collectSuccessfulToolResultIds,
  countDurableToolUses,
  endsWithTextReply,
  extractRememberContents,
  hasCommittedTextReply,
  type MessageLike,
} from "../memory-run-evidence.js";

const DURABLE = new Set(["file_write", "remember"]);

/**
 * Persisted message rows carry their blocks as a JSON string; the readers
 * parse it. Rows are built that way here so the test exercises the same
 * shape the jobs read.
 */
function row(role: string, blocks: unknown[]): MessageLike {
  return { role, content: JSON.stringify(blocks) };
}
const use = (id: string, name: string, input: unknown = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const result = (id: string, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  is_error: isError,
  content: "…",
});
const text = (value: string) => ({ type: "text", text: value });

describe("collectSuccessfulToolResultIds", () => {
  test("collects non-error tool_result ids from user rows only, tolerating malformed rows", () => {
    const ids = collectSuccessfulToolResultIds([
      row("user", [result("ok"), result("bad", true)]),
      row("assistant", [result("not-a-user-row")]),
      { role: "user", content: "{not json" },
      row("user", [result("second")]),
    ]);
    expect([...ids].sort()).toEqual(["ok", "second"]);
  });
});

describe("countDurableToolUses", () => {
  const messages = [
    row("assistant", [
      use("a", "file_write"),
      use("b", "file_write"),
      use("c", "file_read"),
    ]),
    row("user", [result("a"), result("b", true), result("c")]),
  ];

  test("counts only the named tools, and with a success set only verified executions", () => {
    expect(countDurableToolUses(messages, DURABLE, null)).toBe(2);
    expect(
      countDurableToolUses(
        messages,
        DURABLE,
        collectSuccessfulToolResultIds(messages),
      ),
    ).toBe(1);
    expect(countDurableToolUses(messages, new Set(["file_read"]), null)).toBe(
      1,
    );
  });
});

describe("hasCommittedTextReply", () => {
  test("true only when the LAST assistant row carries non-blank text", () => {
    expect(
      hasCommittedTextReply([
        row("assistant", [text("narrating")]),
        row("assistant", [text("   ")]),
      ]),
    ).toBe(false);
    expect(
      hasCommittedTextReply([
        row("assistant", [use("a", "file_write")]),
        row("user", [result("a")]),
        row("assistant", [text("Done.")]),
      ]),
    ).toBe(true);
    expect(hasCommittedTextReply([{ role: "assistant", content: "{" }])).toBe(
      false,
    );
  });
});

describe("endsWithTextReply", () => {
  test("true only when the final row is an assistant reply with text and no tool call", () => {
    expect(
      endsWithTextReply([
        row("assistant", [use("a", "file_write")]),
        row("user", [result("a")]),
        row("assistant", [text("Filed it.")]),
      ]),
    ).toBe(true);
    // Narration on the row that also calls a tool, then a tool result: the
    // run stopped mid-loop, whatever the narration said.
    expect(
      endsWithTextReply([
        row("assistant", [
          text("Fixing that page now."),
          use("a", "file_write"),
        ]),
        row("user", [result("a")]),
      ]),
    ).toBe(false);
    expect(
      endsWithTextReply([
        row("assistant", [text("Done."), use("b", "file_read")]),
      ]),
    ).toBe(false);
    expect(endsWithTextReply([row("assistant", [text("   ")])])).toBe(false);
    expect(endsWithTextReply([{ role: "assistant", content: "{" }])).toBe(
      false,
    );
    expect(endsWithTextReply([])).toBe(false);
  });
});

describe("extractRememberContents", () => {
  const messages = [
    row("assistant", [
      use("a", "remember", { content: " one " }),
      use("b", "remember", { content: ["two", "", "three"] }),
      use("c", "remember", { content: "failed" }),
      use("d", "file_write", { content: "not a remember" }),
    ]),
    row("user", [result("a"), result("b"), result("c", true)]),
  ];

  test("flattens batched facts, trims, and drops blanks", () => {
    expect(extractRememberContents(messages)).toEqual([
      "one",
      "two",
      "three",
      "failed",
    ]);
  });

  test("with a success set, a failed remember's facts are excluded", () => {
    expect(
      extractRememberContents(
        messages,
        collectSuccessfulToolResultIds(messages),
      ),
    ).toEqual(["one", "two", "three"]);
  });
});
