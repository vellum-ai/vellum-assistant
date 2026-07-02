import { describe, expect, test } from "bun:test";

import {
  canStopGeneration,
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

describe("canStopGeneration — authoritative processing close-gate", () => {
  test("cannot stop once the server reports the turn idle", () => {
    expect(
      canStopGeneration("thinking", ctx({ snapshotProcessing: false })),
    ).toBe(false);
  });

  test("can still stop while awaiting the first token after a send", () => {
    expect(
      canStopGeneration(
        "thinking",
        ctx({ snapshotProcessing: false, hasPendingAssistantResponse: true }),
      ),
    ).toBe(true);
  });

  test("undefined processing leaves phase-driven stop behavior intact", () => {
    expect(canStopGeneration("streaming", ctx({ snapshotProcessing: undefined }))).toBe(
      true,
    );
  });
});
