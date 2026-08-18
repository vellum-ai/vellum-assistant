/**
 * A pending confirmation must be reachable: whenever no tool-call chip is
 * showing it, the transcript's trailer row has to.
 *
 * The projection is real here; only the two chat stores the hook reads are
 * stubbed, with `pendingConfirmation` mutable so each case can set the prompt
 * it needs. Lives beside `use-transcript-data.test.ts` rather than inside it
 * because that file pins `pendingConfirmation` to null for its own scenarios,
 * and `mock.module` is process-global.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { PendingConfirmationState } from "@/types/interaction-ui-types";

let pendingConfirmation: PendingConfirmationState | null = null;

mock.module("@/domains/chat/chat-session-store", () => ({
  useChatSessionStore: {
    use: { ephemeralMetaResults: () => [] },
  },
}));

mock.module("@/domains/chat/interaction-store", () => ({
  useInteractionStore: {
    use: {
      pendingSecret: () => null,
      pendingConfirmation: () => pendingConfirmation,
      pendingContactRequest: () => null,
    },
  },
}));

const { useTranscriptData } = await import("./use-transcript-data");

const REQUEST_ID = "req-1";

function assistantWithToolCall(toolCall: ChatMessageToolCall): DisplayMessage {
  return { id: "m1", role: "assistant", toolCalls: [toolCall] };
}

/** A tool call already carrying the active prompt, as the reducer stamps it. */
function carrying(
  overrides: Partial<ChatMessageToolCall> & { id: string; name: string },
): ChatMessageToolCall {
  return {
    input: {},
    pendingConfirmation: { requestId: REQUEST_ID },
    ...overrides,
  } as ChatMessageToolCall;
}

function trailerRowCount(messages: DisplayMessage[]): number {
  const { result } = renderHook(() =>
    useTranscriptData({
      messages,
      showThinking: false,
      turnActive: false,
      thinkingLabel: null,
      showOnboardingChoice: false,
      creditsExhausted: false,
    }),
  );
  return result.current.transcriptItems.filter(
    (item) => item.kind === "pendingConfirmation",
  ).length;
}

describe("pending confirmation is always reachable", () => {
  beforeEach(() => {
    pendingConfirmation = {
      requestId: REQUEST_ID,
      toolName: "bash",
    } as PendingConfirmationState;
  });

  test("a prompt on a chip the transcript draws is not repeated in the trailer", () => {
    const messages = [
      assistantWithToolCall(carrying({ id: "tc-1", name: "bash" })),
    ];

    // The chip renders it, so a trailer row would be a second approve/deny
    // pair for one decision.
    expect(trailerRowCount(messages)).toBe(0);
  });

  test("a prompt on a subagent spawn still gets a trailer row", () => {
    const messages = [
      assistantWithToolCall(carrying({ id: "tc-1", name: "subagent_spawn" })),
    ];

    // A spawn renders an inline subagent card, not a chip, so nothing on
    // screen carries the prompt. Suppressing the trailer here is what leaves
    // the user with a spinning tool and no way to answer until it times out.
    expect(trailerRowCount(messages)).toBe(1);
  });

  test("a spawn dispatched through skill_execute counts the same", () => {
    const messages = [
      assistantWithToolCall(
        carrying({
          id: "tc-1",
          name: "skill_execute",
          input: { tool: "subagent_spawn" },
        }),
      ),
    ];

    // The wire reports `skill_execute` for a re-dispatched spawn, so matching
    // on the raw name alone would miss it and re-open the same hole.
    expect(trailerRowCount(messages)).toBe(1);
  });

  test("an unattached prompt gets a trailer row", () => {
    const messages = [
      assistantWithToolCall({
        id: "tc-1",
        name: "bash",
        input: {},
      } as ChatMessageToolCall),
    ];

    expect(trailerRowCount(messages)).toBe(1);
  });

  test("no prompt, no trailer row", () => {
    pendingConfirmation = null;
    const messages = [
      assistantWithToolCall({
        id: "tc-1",
        name: "bash",
        input: {},
      } as ChatMessageToolCall),
    ];

    expect(trailerRowCount(messages)).toBe(0);
  });
});
