/**
 * Tests for `useTranscriptData`'s proactive credits-upsell append: with the
 * balance exhausted, an open conversation gets the card at the transcript
 * tail, a fresh conversation does not (the empty state owns the card there),
 * an in-flight turn suppresses the card until it settles, and a just-failed
 * turn's substituted card is never doubled. The flag also gates the per-row
 * card substitution for tagged provider-error rows. The projection
 * itself (`buildTranscriptItems`) is real; only the two chat stores the hook
 * reads are stubbed inert.
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

function setup(
  messages: DisplayMessage[],
  creditsExhausted: boolean,
  turnActive = false,
) {
  return renderHook(
    (props: { turnActive: boolean }) =>
      useTranscriptData({
        messages,
        showThinking: false,
        turnActive: props.turnActive,
        thinkingLabel: null,
        showOnboardingChoice: false,
        creditsExhausted,
      }),
    { initialProps: { turnActive } },
  );
}

describe("useTranscriptData proactive credits upsell", () => {
  test("exhausted balance appends the card at the tail of an open conversation", () => {
    const { result } = setup(
      [
        makeMessage("m1", "user", "Hello"),
        makeMessage("m2", "assistant", "Hi"),
      ],
      true,
    );

    const items = result.current.transcriptItems;
    expect(items).toHaveLength(3);
    expect(items[2]).toEqual({
      kind: "creditsUpsell",
      key: "credits-upsell-proactive",
    });
  });

  test("no card in a fresh conversation (the empty state renders its own)", () => {
    const { result } = setup([], true);
    expect(result.current.transcriptItems).toEqual([]);
  });

  test("no card while the balance is not exhausted", () => {
    const { result } = setup([makeMessage("m1", "user", "Hello")], false);
    expect(
      result.current.transcriptItems.filter((i) => i.kind === "creditsUpsell"),
    ).toHaveLength(0);
  });

  test("no proactive card while a turn is in flight; it appears once the turn settles", () => {
    const messages = [
      makeMessage("m1", "user", "Hello"),
      makeMessage("m2", "assistant", "Hi"),
    ];
    const { result, rerender } = setup(messages, true, true);

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

  test("a just-failed turn's substituted card is not doubled", () => {
    const errorRow: DisplayMessage = {
      ...makeMessage("m2", "assistant", "I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    };
    const { result } = setup(
      [makeMessage("m1", "user", "Hello"), errorRow],
      true,
    );

    const cards = result.current.transcriptItems.filter(
      (i) => i.kind === "creditsUpsell",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.key).toBe("credits-upsell-m2");
  });

  test("a tagged provider-error row renders as a plain message while the balance is not exhausted", () => {
    // Gated/self-hosted contexts leave the billing hook inert and a top-up
    // clears the flag; in both, the persisted row must keep its visible
    // historical bubble instead of substituting a card that could render
    // nothing.
    const errorRow: DisplayMessage = {
      ...makeMessage("m2", "assistant", "I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    };
    const { result } = setup(
      [makeMessage("m1", "user", "Hello"), errorRow],
      false,
    );

    expect(result.current.transcriptItems.map((i) => i.kind)).toEqual([
      "message",
      "message",
    ]);
  });
});
