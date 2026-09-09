/**
 * `renderHistoryContent` keys the user-facing projection on the row's own
 * `assistantTextVisibility` marker, never on the live flag. The flag is forced
 * ON throughout: a row from a call, a subagent, a live-voice leg, or any turn
 * written before the flag existed carries no marker and must still render its
 * plain text, and a row a `send_user_message` turn marked private must keep
 * projecting even after the flag is turned back off.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as featureFlags from "../../../config/assistant-feature-flags.js";
import { mergeConsecutiveAssistantMessages } from "../../../conversations/message-consolidation.js";
import type { MessageRow } from "../../../persistence/conversation-crud.js";
import type { ContentBlock } from "../../../providers/types.js";
import { renderHistoryContent } from "../shared.js";

let flagSpy: ReturnType<typeof spyOn> | undefined;

function setFlag(enabled: boolean): void {
  flagSpy = spyOn(
    featureFlags,
    "isAssistantFeatureFlagEnabled",
  ).mockImplementation((key: string) =>
    key === "send-user-message" ? enabled : false,
  );
}

const CONTENT = [
  { type: "text", text: "The user wants their calendar." },
  {
    type: "tool_use",
    id: "tu_1",
    name: "send_user_message",
    input: { message: "You have two meetings today." },
  },
];

const PRIVATE = JSON.stringify({ assistantTextVisibility: "private" });
const VISIBLE = JSON.stringify({ assistantTextVisibility: "visible" });

afterEach(() => {
  flagSpy?.mockRestore();
  flagSpy = undefined;
});

describe("renderHistoryContent user-facing projection", () => {
  test("a private row renders the tool's message as its text", () => {
    setFlag(true);
    const rendered = renderHistoryContent(CONTENT, undefined, "m1", PRIVATE);
    expect(rendered.text).toBe("You have two meetings today.");
    expect(rendered.thinkingSegments).toContain(
      "The user wants their calendar.",
    );
    // The call became the reply, so it is no longer a tool chip.
    expect(rendered.toolCalls.map((c) => c.name)).not.toContain(
      "send_user_message",
    );
  });

  test("a fallback row (visible) renders its raw text, so channels deliver it", () => {
    setFlag(true);
    const rendered = renderHistoryContent(
      [{ type: "text", text: "Two meetings today." }],
      undefined,
      "m2",
      VISIBLE,
    );
    expect(rendered.text).toBe("Two meetings today.");
    expect(rendered.textSegments).toEqual(["Two meetings today."]);
  });

  test("an unmarked row renders raw text with the flag on (calls, subagents, live-voice)", () => {
    setFlag(true);
    const rendered = renderHistoryContent(CONTENT, undefined, "m3", undefined);
    expect(rendered.text).toBe("The user wants their calendar.");
    expect(rendered.toolCalls.map((c) => c.name)).toContain(
      "send_user_message",
    );
  });

  test("turning the flag off does not change how a persisted row renders", () => {
    setFlag(true);
    const withFlagOn = renderHistoryContent(CONTENT, undefined, "m4", PRIVATE);
    flagSpy?.mockRestore();
    setFlag(false);
    const withFlagOff = renderHistoryContent(CONTENT, undefined, "m4", PRIVATE);
    expect(withFlagOff.text).toBe(withFlagOn.text);
    expect(withFlagOff.text).toBe("You have two meetings today.");

    const unmarkedOff = renderHistoryContent(
      CONTENT,
      undefined,
      "m5",
      undefined,
    );
    expect(unmarkedOff.text).toBe("The user wants their calendar.");
  });
});

function assistantRow(
  id: string,
  content: unknown[],
  metadata: string,
): MessageRow {
  return {
    id,
    conversationId: "conv-1",
    role: "assistant",
    content: content as ContentBlock[],
    createdAt: Date.now(),
    displayOrder: 0,
    seen: 1,
    metadata,
    clientMessageId: null,
    finalized: 1,
  } as MessageRow;
}

describe("history reload across a visibility change", () => {
  test("a private row and the fallback row after it both keep their answer", () => {
    setFlag(true);
    // The shape a tool-gated turn writes when the model narrates progress
    // through the tool and then ends a later turn on raw text.
    const rows = [
      assistantRow("private", CONTENT, PRIVATE),
      assistantRow(
        "fallback",
        [{ type: "text", text: "Two meetings today." }],
        VISIBLE,
      ),
    ];

    const { messages } = mergeConsecutiveAssistantMessages(rows);
    expect(messages).toHaveLength(2);

    const rendered = messages.map((m) =>
      renderHistoryContent(m.content, undefined, m.id, m.metadata),
    );
    expect(rendered.map((r) => r.text)).toEqual([
      "You have two meetings today.",
      "Two meetings today.",
    ]);
  });
});
