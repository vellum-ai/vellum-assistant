/**
 * The attention list's `latestAssistantSnippet` is a user-facing preview, so it
 * reads through the row-aware projection.
 *
 * On a turn that routed its reply through `send_user_message`, the row's plain
 * text is a private scratchpad and the reply lives inside the tool call. A
 * snippet built from the row itself puts the scratchpad on this wire, and a
 * gated turn usually ends on wrap-up notes, so the row attention points at
 * often holds nothing a user ever read.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { MessageRow } from "../../../persistence/conversation-crud.js";
import * as conversationCrud from "../../../persistence/conversation-crud.js";
import { resolveAssistantSnippet } from "../conversation-attention-routes.js";

const PRIVATE = JSON.stringify({ assistantTextVisibility: "private" });
const SCRATCHPAD = "SECRET reasoning the user never saw";

let rows: MessageRow[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function row(
  id: string,
  content: unknown[],
  metadata: string | null = null,
): MessageRow {
  return {
    id,
    conversationId: "conv-1",
    role: "assistant",
    content,
    createdAt: Date.now(),
    metadata,
  } as unknown as MessageRow;
}

const sendCall = (message: string, id = "tu_1"): unknown => ({
  type: "tool_use",
  id,
  name: "send_user_message",
  input: { message },
});

beforeEach(() => {
  rows = [];
  spies.push(
    spyOn(conversationCrud, "getMessageById").mockImplementation(
      (id: string) => rows.find((r) => r.id === id) ?? null,
    ),
    spyOn(conversationCrud, "getAssistantMessageIdsInTurn").mockImplementation(
      () => rows.map((r) => r.id),
    ),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

describe("latestAssistantSnippet on a gated turn", () => {
  test("quotes the delivered message, never the scratchpad", () => {
    rows = [
      row(
        "a1",
        [{ type: "text", text: SCRATCHPAD }, sendCall("Two meetings today.")],
        PRIVATE,
      ),
    ];

    const snippet = resolveAssistantSnippet("a1");

    expect(snippet).toBe("Two meetings today.");
    expect(snippet).not.toContain(SCRATCHPAD);
  });

  test("walks back when the row it points at delivered nothing", () => {
    // A gated turn ends on wrap-up notes: the reply is on the earlier row.
    rows = [
      row("a1", [sendCall("Two meetings today.")], PRIVATE),
      row(
        "a2",
        [{ type: "text", text: "Told them about the meetings." }],
        PRIVATE,
      ),
    ];

    const snippet = resolveAssistantSnippet("a2");

    expect(snippet).toBe("Two meetings today.");
    expect(snippet).not.toContain("Told them");
  });

  test("returns nothing when a gated turn delivered nothing at all", () => {
    rows = [
      row("a1", [{ type: "text", text: "notes" }], PRIVATE),
      row("a2", [{ type: "text", text: "more notes" }], PRIVATE),
    ];

    expect(resolveAssistantSnippet("a2")).toBeNull();
  });

  test("an ordinary row is read from itself alone", () => {
    // No walk-back for an unmarked row: the latest row is the preview, as
    // before.
    rows = [
      row("a1", [{ type: "text", text: "earlier answer" }]),
      row("a2", [{ type: "tool_use", id: "t", name: "bash", input: {} }]),
    ];

    expect(resolveAssistantSnippet("a2")).toContain("Tool use (bash)");
  });

  test("an ordinary row with text quotes that text", () => {
    rows = [row("a1", [{ type: "text", text: "Here is your answer." }])];

    expect(resolveAssistantSnippet("a1")).toBe("Here is your answer.");
  });
});
