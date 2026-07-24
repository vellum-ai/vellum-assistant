import { describe, expect, test } from "bun:test";

import {
  isAssistantBusy,
  isConversationProcessing,
  isTurnClosedBySnapshot,
  shouldShowThinkingIndicator,
  type UIContext,
} from "@/domains/chat/turn-selectors";

// A context with every gate off — the caller overrides only what a case needs.
const ctx = (over: Partial<UIContext> = {}): UIContext => ({
  hasStreamingAssistantMessage: false,
  hasStreamingAssistantThinking: false,
  hasPendingSecret: false,
  hasPendingConfirmation: false,
  hasPendingQuestion: false,
  hasPendingContactRequest: false,
  hasUncompletedVisibleSurface: false,
  activeConversationIsProcessing: false,
  hasPendingAssistantResponse: false,
  ...over,
});

describe("isTurnClosedBySnapshot — the shared close-gate", () => {
  test("closes the turn when the snapshot reports idle and no reply is pending", () => {
    expect(
      isTurnClosedBySnapshot(ctx({ snapshotProcessing: false })),
    ).toBe(true);
  });

  test("does NOT close during the just-sent window (a reply is pending)", () => {
    expect(
      isTurnClosedBySnapshot(
        ctx({ snapshotProcessing: false, hasPendingAssistantResponse: true }),
      ),
    ).toBe(false);
  });

  test("undefined processing (pre-0.8.8 / cold snapshot) never closes the turn", () => {
    expect(
      isTurnClosedBySnapshot(ctx({ snapshotProcessing: undefined })),
    ).toBe(false);
  });

  test("processing:true never closes the turn", () => {
    expect(isTurnClosedBySnapshot(ctx({ snapshotProcessing: true }))).toBe(false);
  });
});

describe("isConversationProcessing — row flag reconciled with the close-gate", () => {
  test("the impossible triple can't survive: a snapshot-closed turn reads not-processing", () => {
    // The reported state: the conversation-row `isProcessing` flag is latched
    // true (dropped terminal SSE event, row query not yet refetched) while the
    // rolling snapshot has authoritatively closed the turn. The reconciled flag
    // must agree with the suppressed indicators, not with the stale row.
    const c = ctx({
      activeConversationIsProcessing: true,
      snapshotProcessing: false,
    });
    expect(isConversationProcessing(c)).toBe(false);
    // ...and it lines up with the indicator selectors on the same context.
    expect(isAssistantBusy("thinking", c)).toBe(false);
    expect(shouldShowThinkingIndicator("thinking", 0, c)).toBe(false);
  });

  test("stays processing while the row flag is set and the snapshot hasn't closed", () => {
    expect(
      isConversationProcessing(
        ctx({ activeConversationIsProcessing: true, snapshotProcessing: true }),
      ),
    ).toBe(true);
  });

  test("stays processing in the just-sent window even when the snapshot still reads idle", () => {
    expect(
      isConversationProcessing(
        ctx({
          activeConversationIsProcessing: true,
          snapshotProcessing: false,
          hasPendingAssistantResponse: true,
        }),
      ),
    ).toBe(true);
  });

  test("not processing when the row flag itself is false", () => {
    expect(
      isConversationProcessing(
        ctx({ activeConversationIsProcessing: false, snapshotProcessing: true }),
      ),
    ).toBe(false);
  });

  test("pre-0.8.8 (undefined snapshot) trusts the row flag unchanged", () => {
    expect(
      isConversationProcessing(
        ctx({ activeConversationIsProcessing: true, snapshotProcessing: undefined }),
      ),
    ).toBe(true);
  });
});

describe("shouldShowThinkingIndicator — authoritative processing close-gate", () => {
  test("hides a stuck 'thinking' phase when the server reports the turn idle", () => {
    // The incident: SSE terminal event dropped, so `phase` never left
    // `thinking`; the reseeded snapshot reports `processing: false` and an
    // assistant reply already rendered (no pending response).
    expect(
      shouldShowThinkingIndicator("thinking", 0, ctx({ snapshotProcessing: false })),
    ).toBe(false);
  });

  test("keeps showing in the just-sent window (waiting for the first token)", () => {
    // Right after a send the snapshot still reads the prior idle, but we are
    // legitimately awaiting the assistant's first row — the dots must stay.
    expect(
      shouldShowThinkingIndicator(
        "thinking",
        0,
        ctx({ snapshotProcessing: false, hasPendingAssistantResponse: true }),
      ),
    ).toBe(true);
  });

  test("undefined processing (pre-0.8.8) leaves phase-only behavior intact", () => {
    expect(
      shouldShowThinkingIndicator("thinking", 0, ctx({ snapshotProcessing: undefined })),
    ).toBe(true);
  });

  test("processing:true does not suppress the indicator", () => {
    expect(
      shouldShowThinkingIndicator("thinking", 0, ctx({ snapshotProcessing: true })),
    ).toBe(true);
  });
});

describe("isAssistantBusy — authoritative processing close-gate", () => {
  test("cannot stop once the server reports the turn idle", () => {
    expect(
      isAssistantBusy("thinking", ctx({ snapshotProcessing: false })),
    ).toBe(false);
  });

  test("can still stop while awaiting the first token after a send", () => {
    expect(
      isAssistantBusy(
        "thinking",
        ctx({ snapshotProcessing: false, hasPendingAssistantResponse: true }),
      ),
    ).toBe(true);
  });

  test("undefined processing leaves phase-driven stop behavior intact", () => {
    expect(isAssistantBusy("streaming", ctx({ snapshotProcessing: undefined }))).toBe(
      true,
    );
  });
});

describe("isAssistantBusy — awaiting_user_input without a pending prompt", () => {
  test("stays busy when a prompt resolved but the turn keeps streaming (LUM-2786)", () => {
    // The incident state: the phase is stranded at `awaiting_user_input` after
    // an ask_question card resolved, yet the assistant is still processing —
    // an assistant message is streaming, the conversation is processing, the
    // snapshot reports processing, and no prompt/surface is actually pending.
    expect(
      isAssistantBusy(
        "awaiting_user_input",
        ctx({
          hasStreamingAssistantMessage: true,
          activeConversationIsProcessing: true,
          snapshotProcessing: true,
        }),
      ),
    ).toBe(true);
  });

  test("not busy when a question prompt is actually pending", () => {
    expect(
      isAssistantBusy(
        "awaiting_user_input",
        ctx({
          hasStreamingAssistantMessage: true,
          activeConversationIsProcessing: true,
          snapshotProcessing: true,
          hasPendingQuestion: true,
        }),
      ),
    ).toBe(false);
  });

  test("not busy when an interactive surface is still uncompleted", () => {
    expect(
      isAssistantBusy(
        "awaiting_user_input",
        ctx({
          hasUncompletedVisibleSurface: true,
          snapshotProcessing: true,
        }),
      ),
    ).toBe(false);
  });

  test("close-gate wins: not busy when the server reports the turn idle", () => {
    expect(
      isAssistantBusy(
        "awaiting_user_input",
        ctx({ snapshotProcessing: false }),
      ),
    ).toBe(false);
  });
});
