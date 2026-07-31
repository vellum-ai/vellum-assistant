/**
 * Integration test for `useTranscriptData`'s credits-upsell wiring: the hook
 * passes its inputs through to the projection, which appends the proactive
 * card once an exhausted-balance turn settles and never while one is in
 * flight. The combination coverage (dedupe, empty conversations, substitution
 * gating) lives with the projection in `build-items.test.ts`; here the
 * projection is real and only the two chat stores the hook reads are stubbed
 * inert.
 */
import { describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

mock.module("@/domains/chat/chat-session-store", () => ({
  useChatSessionStore: {
    use: { ephemeralMetaResults: () => [] },
  },
}));

mock.module("@/domains/chat/interaction-store", () => ({
  useInteractionStore: {
    use: {
      pendingSecret: () => null,
      pendingConfirmation: () => null,
      pendingContactRequest: () => null,
    },
  },
}));

const { useTranscriptData } = await import("./use-transcript-data");

function makeMessage(
  id: string,
  role: DisplayMessage["role"],
  text: string,
): DisplayMessage {
  return { id, role, ...textBody(text) };
}

describe("useTranscriptData proactive credits upsell", () => {
  test("no proactive card while a turn is in flight; it appears once the turn settles", () => {
    const messages = [
      makeMessage("m1", "user", "Hello"),
      makeMessage("m2", "assistant", "Hi"),
    ];
    const { result, rerender } = renderHook(
      (props: { turnActive: boolean }) =>
        useTranscriptData({
          messages,
          showThinking: false,
          turnActive: props.turnActive,
          thinkingLabel: null,
          showOnboardingChoice: false,
          creditsExhausted: true,
        }),
      { initialProps: { turnActive: true } },
    );

    // In flight: only the thinking slot trails the messages, no credit wall
    // under the live progress indicator.
    expect(result.current.transcriptItems.map((i) => i.kind)).toEqual([
      "message",
      "message",
      "thinking",
    ]);

    rerender({ turnActive: false });

    expect(result.current.transcriptItems.map((i) => i.kind)).toEqual([
      "message",
      "message",
      "creditsUpsell",
    ]);
  });
});
