import { describe, expect, test } from "bun:test";

import {
  isActiveTurnLive,
  isAssistantBusy,
  shouldShowThinkingIndicator,
  type UIContext,
} from "@/domains/chat/turn-selectors";

// A context with every gate off — the caller overrides only what a case needs.
// `snapshotProcessing` defaults to `true` (a live turn on a 0.8.8+ daemon) so
// cases opt into the close by overriding it; `undefined` exercises the legacy
// fallback explicitly.
const ctx = (over: Partial<UIContext> = {}): UIContext => ({
  hasStreamingAssistantMessage: false,
  hasStreamingAssistantThinking: false,
  hasPendingSecret: false,
  hasPendingConfirmation: false,
  hasPendingQuestion: false,
  hasPendingContactRequest: false,
  hasUncompletedVisibleSurface: false,
  activeConversationIsProcessing: false,
  snapshotProcessing: true,
  streamAheadOfServer: false,
  ...over,
});

describe("isActiveTurnLive — server owns the close, phase owns the open", () => {
  test("server says live → live regardless of phase", () => {
    expect(isActiveTurnLive("idle", ctx({ snapshotProcessing: true }))).toBe(true);
  });

  test("server-authoritative close: snapshot idle AND caught up → not live even if phase is stuck", () => {
    // The dropped-terminal case the old close-gate handled: `phase` never left
    // a sending state, but the snapshot has caught up to the stream (S >= L)
    // and reports idle. The turn is over.
    expect(
      isActiveTurnLive(
        "thinking",
        ctx({ snapshotProcessing: false, streamAheadOfServer: false }),
      ),
    ).toBe(false);
  });

  test("THE INCIDENT: genuinely live but snapshot reads a stale false → stays live", () => {
    // The reported `_vellumDebug.chat.streamingRing()` state: the turn is
    // genuinely processing, the live stream has advanced past the durable
    // `/messages` snapshot (L > S), so the snapshot's `processing: false`
    // predates the turn and must NOT close it.
    expect(
      isActiveTurnLive(
        "thinking",
        ctx({ snapshotProcessing: false, streamAheadOfServer: true }),
      ),
    ).toBe(true);
  });

  test("just-sent window: streamAheadOfServer covers it (send advances L past S)", () => {
    // Right after a send, the optimistic phase is `thinking` and the local
    // frontier has moved past the server's, so a stale snapshot false can't
    // suppress the dots before the first token.
    expect(
      isActiveTurnLive(
        "thinking",
        ctx({ snapshotProcessing: false, streamAheadOfServer: true }),
      ),
    ).toBe(true);
  });

  test("stale-false but phase idle and stream ahead → not live (nothing optimistic in flight)", () => {
    expect(
      isActiveTurnLive(
        "idle",
        ctx({ snapshotProcessing: false, streamAheadOfServer: true }),
      ),
    ).toBe(false);
  });

  describe("pre-0.8.8 fallback (snapshotProcessing === undefined)", () => {
    test("phase drives liveness when the daemon omits the flag", () => {
      expect(
        isActiveTurnLive("streaming", ctx({ snapshotProcessing: undefined })),
      ).toBe(true);
      expect(
        isActiveTurnLive("idle", ctx({ snapshotProcessing: undefined })),
      ).toBe(false);
    });

    test("the legacy conversation-row signal covers external-channel turns", () => {
      // No local send (phase idle) but the row flag says the conversation is
      // processing — a Slack/Telegram turn streaming into an open tab.
      expect(
        isActiveTurnLive(
          "idle",
          ctx({ snapshotProcessing: undefined, activeConversationIsProcessing: true }),
        ),
      ).toBe(true);
    });

    test("the row flag is IGNORED once the server flag is defined (0.8.8+)", () => {
      // A latched row flag must not resurrect a turn the server has closed.
      expect(
        isActiveTurnLive(
          "idle",
          ctx({
            snapshotProcessing: false,
            streamAheadOfServer: false,
            activeConversationIsProcessing: true,
          }),
        ),
      ).toBe(false);
    });
  });
});

describe("isAssistantBusy", () => {
  test("busy tracks isActiveTurnLive", () => {
    expect(isAssistantBusy("thinking", ctx({ snapshotProcessing: true }))).toBe(true);
    expect(
      isAssistantBusy("thinking", ctx({ snapshotProcessing: false })),
    ).toBe(false);
  });

  test("THE INCIDENT: stays busy when genuinely processing behind a stale snapshot", () => {
    // The exact bug: isAssistantBusy must be true here, not false.
    expect(
      isAssistantBusy(
        "thinking",
        ctx({ snapshotProcessing: false, streamAheadOfServer: true }),
      ),
    ).toBe(true);
  });

  test("a pending prompt suppresses busy even while the turn is live", () => {
    expect(
      isAssistantBusy(
        "awaiting_user_input",
        ctx({ snapshotProcessing: true, hasPendingQuestion: true }),
      ),
    ).toBe(false);
  });

  test("an uncompleted interactive surface suppresses busy", () => {
    expect(
      isAssistantBusy(
        "awaiting_user_input",
        ctx({ snapshotProcessing: true, hasUncompletedVisibleSurface: true }),
      ),
    ).toBe(false);
  });

  test("stays busy when a prompt resolved but the turn keeps streaming (LUM-2786)", () => {
    // Phase stranded at awaiting_user_input after an ask_question resolved, but
    // the server still reports the turn live and no prompt is actually pending.
    expect(
      isAssistantBusy(
        "awaiting_user_input",
        ctx({ snapshotProcessing: true, hasStreamingAssistantMessage: true }),
      ),
    ).toBe(true);
  });
});

describe("shouldShowThinkingIndicator", () => {
  test("visible while thinking on a live turn with a quiet UI", () => {
    expect(
      shouldShowThinkingIndicator("thinking", 0, ctx({ snapshotProcessing: true })),
    ).toBe(true);
  });

  test("THE INCIDENT: dots stay while genuinely processing behind a stale snapshot", () => {
    expect(
      shouldShowThinkingIndicator(
        "thinking",
        0,
        ctx({ snapshotProcessing: false, streamAheadOfServer: true }),
      ),
    ).toBe(true);
  });

  test("server-authoritative close hides a stuck 'thinking' phase", () => {
    expect(
      shouldShowThinkingIndicator(
        "thinking",
        0,
        ctx({ snapshotProcessing: false, streamAheadOfServer: false }),
      ),
    ).toBe(false);
  });

  test("hidden once an assistant message is streaming (unless still thinking)", () => {
    expect(
      shouldShowThinkingIndicator(
        "streaming",
        0,
        ctx({ snapshotProcessing: true, hasStreamingAssistantMessage: true }),
      ),
    ).toBe(false);
  });

  test("an in-flight tool call suppresses the dots", () => {
    expect(
      shouldShowThinkingIndicator("thinking", 1, ctx({ snapshotProcessing: true })),
    ).toBe(false);
  });

  test("inline reasoning owns the loading state — dots defer", () => {
    expect(
      shouldShowThinkingIndicator(
        "thinking",
        0,
        ctx({ snapshotProcessing: true, hasStreamingAssistantThinking: true }),
      ),
    ).toBe(false);
  });

  test("each pending prompt suppresses the dots", () => {
    for (const field of [
      "hasPendingSecret",
      "hasPendingConfirmation",
      "hasPendingQuestion",
      "hasPendingContactRequest",
      "hasUncompletedVisibleSurface",
    ] as const) {
      expect(
        shouldShowThinkingIndicator(
          "thinking",
          0,
          ctx({ snapshotProcessing: true, [field]: true }),
        ),
      ).toBe(false);
    }
  });
});
