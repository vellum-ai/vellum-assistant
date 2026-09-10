/**
 * Reply suggestions are keyed on the id a client actually holds.
 *
 * `/messages` folds a run of consecutive assistant rows into one display turn
 * that takes the FIRST row's id, so that is the id a client asks about. The
 * staleness check has to compare against the same display turns; comparing
 * against the raw tail calls every multi-row turn stale. A gated
 * `send_user_message` reply is always at least two rows (the call, then the
 * post-tool wrap-up), so on that path the raw tail is never the client's id
 * and suggestions would never be offered at all.
 *
 * The real renderer and the real consolidation run here; only the two row
 * reads are stubbed.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { MessageRow } from "../../../persistence/conversation-crud.js";
import * as conversationCrud from "../../../persistence/conversation-crud.js";
import * as conversationKeyStore from "../../../persistence/conversation-key-store.js";
import { handleGetSuggestion } from "../conversation-routes.js";

const PRIVATE = JSON.stringify({ assistantTextVisibility: "private" });

let rows: MessageRow[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function row(
  id: string,
  role: string,
  content: unknown[],
  metadata: string | null = null,
): MessageRow {
  return {
    id,
    conversationId: "conv-1",
    role,
    content,
    createdAt: Date.now(),
    displayOrder: 0,
    seen: 1,
    metadata,
  } as unknown as MessageRow;
}

const text = (value: string): unknown[] => [{ type: "text", text: value }];

/** What a gated turn's first row holds: private notes plus the delivered call. */
const gatedCall = (notes: string, message: string): unknown[] => [
  { type: "text", text: notes },
  {
    type: "tool_use",
    id: "tu_1",
    name: "send_user_message",
    input: { message },
  },
];

function deps(cache: Map<string, string>) {
  return { suggestionCache: cache, suggestionInFlight: new Map() };
}

beforeEach(() => {
  rows = [];
  spies.push(
    spyOn(conversationCrud, "getMessages").mockImplementation(() => rows),
    spyOn(conversationCrud, "getConversation").mockImplementation(
      () => ({ id: "conv-1", source: "user" }) as never,
    ),
    spyOn(conversationKeyStore, "getConversationByKey").mockImplementation(
      () => ({ conversationId: "conv-1" }) as never,
    ),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

describe("reply suggestions across a consolidated turn", () => {
  /** The shape a gated reply writes: the call row, then the wrap-up row. */
  const seedGatedTurn = (): void => {
    rows.push(
      row("user-1", "user", text("hi")),
      row(
        "assistant-call",
        "assistant",
        gatedCall("checking the calendar", "Two meetings today."),
        PRIVATE,
      ),
      row("assistant-wrapup", "assistant", text("Told them."), PRIVATE),
    );
  };

  test("the first row of a merged run is not stale", async () => {
    seedGatedTurn();
    const cache = new Map([["assistant-call", "Anything else?"]]);

    const result = await handleGetSuggestion(
      {
        queryParams: { conversationId: "conv-1", messageId: "assistant-call" },
      },
      deps(cache),
    );

    expect(result.stale).toBeUndefined();
    expect(result).toMatchObject({
      suggestion: "Anything else?",
      messageId: "assistant-call",
    });
  });

  test("a row the run folded away is stale", async () => {
    // The client never holds this id, so asking about it means it is behind.
    seedGatedTurn();

    const result = await handleGetSuggestion(
      {
        queryParams: {
          conversationId: "conv-1",
          messageId: "assistant-wrapup",
        },
      },
      deps(new Map()),
    );

    expect(result.stale).toBe(true);
  });

  test("a newer turn still makes an older id stale", async () => {
    seedGatedTurn();
    rows.push(
      row("user-2", "user", text("more")),
      row(
        "assistant-newer",
        "assistant",
        gatedCall("looking", "On it."),
        PRIVATE,
      ),
    );

    const result = await handleGetSuggestion(
      {
        queryParams: { conversationId: "conv-1", messageId: "assistant-call" },
      },
      deps(new Map()),
    );

    expect(result.stale).toBe(true);
  });

  test("an ordinary single-row turn is unchanged", async () => {
    rows.push(
      row("user-1", "user", text("hi")),
      row("assistant-only", "assistant", text("Hello.")),
    );
    const cache = new Map([["assistant-only", "Anything else?"]]);

    const result = await handleGetSuggestion(
      {
        queryParams: { conversationId: "conv-1", messageId: "assistant-only" },
      },
      deps(cache),
    );

    expect(result).toMatchObject({
      suggestion: "Anything else?",
      messageId: "assistant-only",
    });
  });
});
