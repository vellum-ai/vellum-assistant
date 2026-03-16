import { describe, expect, test } from "bun:test";

import { createContextSummaryMessage } from "../context/window-manager.js";
import { buildMemoryQuery } from "../memory/query-builder.js";
import type { Message } from "../providers/types.js";

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("memory query builder", () => {
  test("builds deterministic user-request section when no summary exists", () => {
    const messages = [userMessage("hello")];
    const query = buildMemoryQuery("Need a memory recall query.", messages);

    expect(query).toBe("Need a memory recall query.");
    expect(query).not.toContain("Context summary:");
  });

  test("includes session summary section when summary context message exists", () => {
    const messages = [
      createContextSummaryMessage("## Goals\n- Keep tests deterministic"),
      userMessage("what did we decide?"),
    ];
    const query = buildMemoryQuery("Summarize decisions.", messages);

    expect(query).toContain("Summarize decisions.");
    expect(query).toContain("Context summary:");
    expect(query).toContain("Keep tests deterministic");
    expect(query).not.toContain("## User Request");
    expect(query).not.toContain("## Conversation Context Summary");
  });

  test("truncates oversized sections with deterministic marker", () => {
    const oversizedRequest = "r".repeat(400);
    const oversizedSummary = "s".repeat(500);
    const messages = [createContextSummaryMessage(oversizedSummary)];

    const query = buildMemoryQuery(oversizedRequest, messages, {
      maxUserRequestChars: 120,
      maxSessionSummaryChars: 120,
    });

    expect(query).toContain("<truncated />");
    expect(query).toContain("Context summary:");
    expect(query).not.toContain("## User Request");
    expect(query).not.toContain("## Conversation Context Summary");
  });

  test("returns stable output for identical inputs", () => {
    const messages = [
      createContextSummaryMessage("stable summary"),
      userMessage("latest"),
    ];
    const a = buildMemoryQuery("stable request", messages);
    const b = buildMemoryQuery("stable request", messages);
    expect(a).toBe(b);
  });
});
