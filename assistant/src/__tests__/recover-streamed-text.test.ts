/**
 * Tests for `recoverStreamedTextMissingFromFinal` — the finalize-time guard
 * that re-inserts streamed assistant text the provider's accumulated final
 * snapshot dropped (the interleaved-thinking `thinking → text → thinking →
 * tool_use` shape, LUM-2847 / JARVIS-1324). The streamed mirror is the
 * recovery source; the finalized content stays authoritative whenever it
 * carries visible text of its own.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { recoverStreamedTextMissingFromFinal } from "../daemon/conversation-agent-loop-handlers.js";
import type { ContentBlock } from "../providers/types.js";

const thinking = (text: string): ContentBlock => ({
  type: "thinking",
  thinking: text,
  signature: "sig",
});
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const toolUse = (id: string): ContentBlock => ({
  type: "tool_use",
  id,
  name: "remember",
  input: { content: "note", finish_turn: true },
});

describe("recoverStreamedTextMissingFromFinal", () => {
  test("re-inserts text dropped between two thinking blocks at its stream position", () => {
    const final = [thinking("A"), thinking("B"), toolUse("t1")];
    const streamed = [thinking("A"), text("the reply"), thinking("B")];

    const result = recoverStreamedTextMissingFromFinal(final, streamed);

    expect(result).not.toBeNull();
    expect(result!.content).toEqual([
      thinking("A"),
      text("the reply"),
      thinking("B"),
      toolUse("t1"),
    ]);
    expect(result!.recoveredChars).toBe("the reply".length);
  });

  test("returns null when the finalized content already carries visible text", () => {
    const final = [thinking("A"), text("kept reply"), toolUse("t1")];
    const streamed = [thinking("A"), text("kept reply")];

    expect(recoverStreamedTextMissingFromFinal(final, streamed)).toBeNull();
  });

  test("returns null for a tool-only call that streamed no text", () => {
    const final = [thinking("A"), toolUse("t1")];
    const streamed = [thinking("A")];

    expect(recoverStreamedTextMissingFromFinal(final, streamed)).toBeNull();
  });

  test("ignores whitespace-only streamed text", () => {
    const final = [thinking("A"), toolUse("t1")];
    const streamed = [thinking("A"), text("  \n ")];

    expect(recoverStreamedTextMissingFromFinal(final, streamed)).toBeNull();
  });

  test("without streamed thinking to anchor on, text lands before the first tool call", () => {
    const final = [thinking("A"), thinking("B"), toolUse("t1")];
    const streamed = [text("the reply")];

    const result = recoverStreamedTextMissingFromFinal(final, streamed);

    expect(result!.content).toEqual([
      thinking("A"),
      thinking("B"),
      text("the reply"),
      toolUse("t1"),
    ]);
  });

  test("without thinking or tool blocks in the final content, text appends at the end", () => {
    const final: ContentBlock[] = [];
    const streamed = [text("the reply")];

    const result = recoverStreamedTextMissingFromFinal(final, streamed);

    expect(result!.content).toEqual([text("the reply")]);
  });

  test("multiple interleaved text segments keep their stream order", () => {
    const final = [thinking("A"), thinking("B"), toolUse("t1")];
    const streamed = [
      thinking("A"),
      text("first part"),
      thinking("B"),
      text("second part"),
    ];

    const result = recoverStreamedTextMissingFromFinal(final, streamed);

    expect(result!.content).toEqual([
      thinking("A"),
      text("first part"),
      thinking("B"),
      text("second part"),
      toolUse("t1"),
    ]);
    expect(result!.recoveredChars).toBe(
      "first part".length + "second part".length,
    );
  });

  test("text streamed before any thinking is restored ahead of the first thinking block", () => {
    const final = [thinking("A"), toolUse("t1")];
    const streamed = [text("preamble"), thinking("A")];

    const result = recoverStreamedTextMissingFromFinal(final, streamed);

    expect(result!.content).toEqual([
      text("preamble"),
      thinking("A"),
      toolUse("t1"),
    ]);
  });
});
