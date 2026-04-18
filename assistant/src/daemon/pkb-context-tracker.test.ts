import path from "node:path";
import { describe, expect, test } from "bun:test";

import type { ContentBlock, Message } from "../providers/types.js";
import type { Conversation } from "./conversation.js";
import { getInContextPkbPaths } from "./pkb-context-tracker.js";

const PKB_ROOT = path.resolve("/tmp/test-pkb-root");

// The helper only reads `conversation.messages`. Constructing a real
// `Conversation` instance would require a full daemon setup; casting a
// minimal object through `unknown` keeps the test isolated and pure while
// still exercising the public type.
function makeConversation(messages: Message[]): Conversation {
  return { messages } as unknown as Conversation;
}

function fileReadToolUse(filePath: string): ContentBlock {
  return {
    type: "tool_use",
    id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
    name: "file_read",
    input: { path: filePath },
  };
}

function assistantMessageWithBlocks(blocks: ContentBlock[]): Message {
  return { role: "assistant", content: blocks };
}

describe("getInContextPkbPaths", () => {
  test("auto-inject paths are always present (even with empty conversation)", () => {
    const conversation = makeConversation([]);
    const result = getInContextPkbPaths(
      conversation,
      ["notes/index.md", "journal/2026-04-18.md"],
      PKB_ROOT,
    );
    expect(result).toEqual(
      new Set([
        path.join(PKB_ROOT, "notes/index.md"),
        path.join(PKB_ROOT, "journal/2026-04-18.md"),
      ]),
    );
  });

  test("includes a file_read tool_use with a path inside pkbRoot", () => {
    const insidePath = path.join(PKB_ROOT, "notes/thoughts.md");
    const conversation = makeConversation([
      assistantMessageWithBlocks([fileReadToolUse(insidePath)]),
    ]);
    const result = getInContextPkbPaths(conversation, [], PKB_ROOT);
    expect(result).toEqual(new Set([insidePath]));
  });

  test("excludes a file_read tool_use whose path is outside pkbRoot", () => {
    const conversation = makeConversation([
      assistantMessageWithBlocks([fileReadToolUse("/etc/hosts")]),
    ]);
    const result = getInContextPkbPaths(conversation, [], PKB_ROOT);
    expect(result).toEqual(new Set());
  });

  test("excludes a non-file_read tool_use with a PKB-like path", () => {
    const insidePath = path.join(PKB_ROOT, "notes/thoughts.md");
    const bogus: ContentBlock = {
      type: "tool_use",
      id: "toolu_bogus",
      name: "file_write",
      input: { path: insidePath },
    };
    const conversation = makeConversation([
      assistantMessageWithBlocks([bogus]),
    ]);
    const result = getInContextPkbPaths(conversation, [], PKB_ROOT);
    expect(result).toEqual(new Set());
  });

  test("post-compaction context-summary user message returns only auto-inject paths", () => {
    // After compaction, the structured tool_use blocks have been serialized
    // away and the conversation is just a user-role text message containing
    // the summary.
    const summaryMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "[Context summary] Previously you read notes/thoughts.md and journal/2026-04-18.md...",
        },
      ],
    };
    const conversation = makeConversation([summaryMessage]);
    const autoInject = ["profile/identity.md"];
    const result = getInContextPkbPaths(conversation, autoInject, PKB_ROOT);
    expect(result).toEqual(
      new Set([path.join(PKB_ROOT, "profile/identity.md")]),
    );
  });

  test("path-traversal attempt via ../../etc/passwd is excluded", () => {
    const conversation = makeConversation([
      assistantMessageWithBlocks([
        fileReadToolUse("../../etc/passwd"),
        fileReadToolUse("notes/../../../etc/shadow"),
      ]),
    ]);
    const result = getInContextPkbPaths(conversation, [], PKB_ROOT);
    expect(result).toEqual(new Set());
  });

  test("relative file_read path is NOT treated as inside pkbRoot", () => {
    // `file_read` accepts absolute paths and paths relative to the tool's
    // working directory — NOT to `pkbRoot`. So a relative path like
    // `"notes.md"` is ambiguous: the actual file might have been read from
    // `<workingDir>/notes.md`, not `<pkbRoot>/notes.md`. Marking it as
    // in-context would false-positive and suppress hints for files the
    // model did not actually load.
    const conversation = makeConversation([
      assistantMessageWithBlocks([
        fileReadToolUse("notes.md"),
        fileReadToolUse("./deep/subdir/file.md"),
      ]),
    ]);
    const result = getInContextPkbPaths(conversation, [], PKB_ROOT);
    expect(result).toEqual(new Set());
  });

  test("resolves relative auto-inject paths against pkbRoot", () => {
    const conversation = makeConversation([]);
    const result = getInContextPkbPaths(
      conversation,
      ["./notes/relative.md"],
      PKB_ROOT,
    );
    expect(result).toEqual(
      new Set([path.join(PKB_ROOT, "notes/relative.md")]),
    );
  });

  test("auto-inject and file_read paths union (no duplicates)", () => {
    const insidePath = path.join(PKB_ROOT, "notes/shared.md");
    const conversation = makeConversation([
      assistantMessageWithBlocks([fileReadToolUse(insidePath)]),
    ]);
    const result = getInContextPkbPaths(
      conversation,
      ["notes/shared.md"],
      PKB_ROOT,
    );
    expect(result.size).toBe(1);
    expect(result.has(insidePath)).toBe(true);
  });
});
