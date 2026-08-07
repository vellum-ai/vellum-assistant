import { describe, expect, test } from "bun:test";

import {
  isAssistantBusy,
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

describe("shouldShowThinkingIndicator — authoritative processing close-gate", () => {
  test("hides a stuck 'thinking' phase when the server reports the turn idle", () => {
    // The incident: SSE terminal event dropped, so `phase` never left
    // `thinking`; the reseeded snapshot reports `processing: false` and an
    // assistant reply already rendered (no pending response).
    expect(
      shouldShowThinkingIndicator(
        "thinking",
        0,
        ctx({ snapshotProcessing: false }),
      ),
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
      shouldShowThinkingIndicator(
        "thinking",
        0,
        ctx({ snapshotProcessing: undefined }),
      ),
    ).toBe(true);
  });

  test("processing:true does not suppress the indicator", () => {
    expect(
      shouldShowThinkingIndicator(
        "thinking",
        0,
        ctx({ snapshotProcessing: true }),
      ),
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
    expect(
      isAssistantBusy("streaming", ctx({ snapshotProcessing: undefined })),
    ).toBe(true);
  });
});

describe("isAssistantBusy: authoritative processing open-gate", () => {
  test("busy when the daemon reports processing and no local signal agrees", () => {
    // A reloaded tab, or a daemon holding the processing lock past its last
    // SSE event: the phase is idle and nothing is streaming, yet sends would
    // be queued. The Stop button is the only escape, so this must read busy.
    expect(isAssistantBusy("idle", ctx({ snapshotProcessing: true }))).toBe(
      true,
    );
  });

  test("a pending question still suppresses busy", () => {
    // The prompt IS the UI: a queued-behind-a-prompt daemon must not also
    // render a spinner and a Stop button over the question card.
    expect(
      isAssistantBusy(
        "idle",
        ctx({ snapshotProcessing: true, hasPendingQuestion: true }),
      ),
    ).toBe(false);
  });

  test("a pending confirmation still suppresses busy", () => {
    expect(
      isAssistantBusy(
        "idle",
        ctx({ snapshotProcessing: true, hasPendingConfirmation: true }),
      ),
    ).toBe(false);
  });

  test("processing:false short-circuits from an idle phase", () => {
    expect(isAssistantBusy("idle", ctx({ snapshotProcessing: false }))).toBe(
      false,
    );
  });

  test("undefined processing keeps an idle client not busy", () => {
    expect(
      isAssistantBusy("idle", ctx({ snapshotProcessing: undefined })),
    ).toBe(false);
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
