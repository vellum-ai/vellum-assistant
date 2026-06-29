/**
 * Tests for the pure cache-diff logic. Each case builds two sets of
 * normalized request sections (previous vs current turn) and asserts the
 * computed bust cause, the per-group change flags, message alignment
 * counts, and the optional line-level diff. Mirrors the Anthropic
 * section order (system → messages → tools → settings) so the grouping
 * is exercised against production-shaped input.
 */

import { describe, expect, test } from "bun:test";

import {
  collapseDiffContext,
  computeCacheDiff,
  diffLines,
  type CacheDiffLine,
} from "./cache-diff";
import type { LLMContextSection } from "@vellumai/assistant-api";

function system(text: string): LLMContextSection {
  return { kind: "system", label: "System", text };
}

function message(role: string, text: string): LLMContextSection {
  return { kind: "message", label: role, role, text };
}

function tools(data: unknown): LLMContextSection {
  return { kind: "tool_definitions", label: "Available tools", data };
}

function settings(data: unknown): LLMContextSection {
  return { kind: "settings", label: "Request settings", data };
}

function toolCall(toolName: string, args: unknown): LLMContextSection {
  return {
    kind: "function_call",
    label: `Request tool call (${toolName})`,
    role: "assistant",
    toolName,
    data: args,
  };
}

describe("computeCacheDiff", () => {
  test("reports no-previous when there is no earlier call", () => {
    const result = computeCacheDiff(
      { sections: [system("a"), message("user", "hi")], model: "claude" },
      null,
    );
    expect(result.cause).toBe("no-previous");
    expect(result.currentModel).toBe("claude");
  });

  test("flags a model change above everything else", () => {
    const sections = [system("same"), message("user", "hi")];
    const result = computeCacheDiff(
      { sections, model: "claude-3-5" },
      { sections, model: "claude-3-7" },
    );
    expect(result.cause).toBe("model");
    expect(result.changedGroups.model).toBe(true);
    expect(result.previousModel).toBe("claude-3-7");
    expect(result.currentModel).toBe("claude-3-5");
  });

  test("identifies a changed system prompt and emits a line diff", () => {
    const previous = {
      sections: [system("line one\nold line\nline three"), message("user", "hi")],
      model: "claude",
    };
    const current = {
      sections: [system("line one\nnew line\nline three"), message("user", "hi")],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);

    expect(result.cause).toBe("system");
    expect(result.changedGroups.system).toBe(true);
    expect(result.lineDiffLabel).toBe("System prompt");
    expect(result.lineDiff).not.toBeNull();
    const added = result.lineDiff?.filter((l) => l.type === "added") ?? [];
    const removed = result.lineDiff?.filter((l) => l.type === "removed") ?? [];
    expect(added.map((l) => l.text)).toContain("new line");
    expect(removed.map((l) => l.text)).toContain("old line");
  });

  test("prefers tools over system in cause priority", () => {
    const previous = {
      sections: [system("a"), tools({ name: "old" })],
      model: "claude",
    };
    const current = {
      sections: [system("b"), tools({ name: "new" })],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);
    expect(result.cause).toBe("tools");
    expect(result.changedGroups.tools).toBe(true);
    expect(result.changedGroups.system).toBe(true);
  });

  test("treats appended messages with an intact prefix as no bust", () => {
    const previous = {
      sections: [system("a"), message("user", "one"), message("assistant", "two")],
      model: "claude",
    };
    const current = {
      sections: [
        system("a"),
        message("user", "one"),
        message("assistant", "two"),
        message("user", "three"),
      ],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);
    expect(result.cause).toBe("none");
    expect(result.sharedMessageCount).toBe(2);
    expect(result.appendedMessageCount).toBe(1);
    expect(result.changedGroups.messages).toBe(false);
  });

  test("detects a divergent message inside the cached prefix", () => {
    const previous = {
      sections: [system("a"), message("user", "hello there"), message("assistant", "two")],
      model: "claude",
    };
    const current = {
      sections: [system("a"), message("user", "hello world"), message("assistant", "two")],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);
    expect(result.cause).toBe("messages");
    expect(result.firstChangedMessageIndex).toBe(0);
    expect(result.changedMessageLabel).toBe("user message");
    expect(result.lineDiff).not.toBeNull();
  });

  test("counts removed messages as a likely compaction bust", () => {
    const previous = {
      sections: [
        message("user", "one"),
        message("assistant", "two"),
        message("user", "three"),
      ],
      model: "claude",
    };
    const current = {
      sections: [message("user", "summary"), message("user", "three")],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);
    expect(result.cause).toBe("messages");
    expect(result.removedMessageCount).toBe(1);
  });

  test("flags settings as a low-priority cause when nothing else changed", () => {
    const previous = {
      sections: [system("a"), message("user", "hi"), settings({ temperature: 0 })],
      model: "claude",
    };
    const current = {
      sections: [system("a"), message("user", "hi"), settings({ temperature: 1 })],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);
    expect(result.cause).toBe("settings");
    expect(result.changedGroups.settings).toBe(true);
  });

  test("detects a tool swap when only the tool name differs", () => {
    const previous = {
      sections: [
        system("a"),
        message("user", "hi"),
        toolCall("search", { query: "x" }),
      ],
      model: "claude",
    };
    const current = {
      sections: [
        system("a"),
        message("user", "hi"),
        toolCall("fetch", { query: "x" }),
      ],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);
    expect(result.cause).toBe("messages");
    expect(result.changedGroups.messages).toBe(true);
    expect(result.firstChangedMessageIndex).toBe(1);
  });

  test("ignores object key ordering when comparing section data", () => {
    const previous = {
      sections: [tools({ a: 1, b: 2 })],
      model: "claude",
    };
    const current = {
      sections: [tools({ b: 2, a: 1 })],
      model: "claude",
    };
    const result = computeCacheDiff(current, previous);
    expect(result.cause).toBe("none");
    expect(result.changedGroups.tools).toBe(false);
  });
});

describe("diffLines", () => {
  test("returns null for identical text", () => {
    expect(diffLines("same\ntext", "same\ntext")).toBeNull();
  });

  test("marks added and removed lines around shared context", () => {
    const result = diffLines("keep\nremove", "keep\nadd");
    expect(result?.truncated).toBe(false);
    expect(result?.lines).toEqual([
      { type: "context", text: "keep" },
      { type: "removed", text: "remove" },
      { type: "added", text: "add" },
    ]);
  });

  test("bails out with a truncated marker past the line cap", () => {
    const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const result = diffLines(big, `${big}\nextra`);
    expect(result?.truncated).toBe(true);
    expect(result?.lines).toEqual([]);
  });

  test("aligns multiple changed hunks via the flat-table LCS", () => {
    const result = diffLines("a\nb\nc\nd\ne", "a\nB\nc\nD\ne");
    expect(result?.truncated).toBe(false);
    const byType = (type: CacheDiffLine["type"]) =>
      result?.lines.filter((l) => l.type === type).map((l) => l.text);
    expect(byType("context")).toEqual(["a", "c", "e"]);
    expect(byType("removed")).toEqual(["b", "d"]);
    expect(byType("added")).toEqual(["B", "D"]);
  });

  test("computes past the default cap when given a higher ceiling", () => {
    const base = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const next = `${base}\nextra`;
    // The default cap still bails on this input...
    expect(diffLines(base, next)?.truncated).toBe(true);
    // ...but an explicit higher ceiling diffs it.
    const result = diffLines(base, next, 4000);
    expect(result?.truncated).toBe(false);
    expect(
      result?.lines.some((l) => l.type === "added" && l.text === "extra"),
    ).toBe(true);
  });

  test("still bails when the text exceeds the higher ceiling", () => {
    const huge = Array.from({ length: 4100 }, (_, i) => `line ${i}`).join("\n");
    const result = diffLines(huge, `${huge}\nextra`, 4000);
    expect(result?.truncated).toBe(true);
    expect(result?.lines).toEqual([]);
  });
});

describe("collapseDiffContext", () => {
  function context(text: string): CacheDiffLine {
    return { type: "context", text };
  }

  test("keeps padding context lines around a change and gaps the rest", () => {
    const lines: CacheDiffLine[] = [
      context("0"),
      context("1"),
      context("2"),
      context("3"),
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      context("6"),
      context("7"),
      context("8"),
      context("9"),
    ];
    const entries = collapseDiffContext(lines, 2);
    expect(entries).toEqual([
      { type: "gap", count: 2 },
      { type: "line", line: context("2") },
      { type: "line", line: context("3") },
      { type: "line", line: { type: "removed", text: "old" } },
      { type: "line", line: { type: "added", text: "new" } },
      { type: "line", line: context("6") },
      { type: "line", line: context("7") },
      { type: "gap", count: 2 },
    ]);
  });

  test("collapses an all-context diff into a single gap", () => {
    const entries = collapseDiffContext(
      [context("a"), context("b"), context("c")],
      2,
    );
    expect(entries).toEqual([{ type: "gap", count: 3 }]);
  });
});
