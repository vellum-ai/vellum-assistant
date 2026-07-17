/**
 * Tests for {@link useSeedLiveVoiceSnapshot} (JARVIS-1265).
 *
 * The hook seeds an empty chat snapshot when a live-voice session attaches to
 * the currently-viewed (draft) conversation with no snapshot yet, so the
 * daemon's `user_message_echo` folds in instead of being dropped by
 * `applyEnvelopeToSnapshot`'s null-snapshot no-op. These tests drive the real
 * live-voice, conversation, and chat-session stores.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationStore } from "@/stores/conversation-store";

import { seedLiveVoiceSession } from "./live-voice-fakes.test-helper";
import { useLiveVoiceStore } from "./live-voice-store";
import { useSeedLiveVoiceSnapshot } from "./use-seed-live-voice-snapshot";

const DRAFT_CONVERSATION_ID = "conv-draft";
const ASSISTANT_ID = "assistant-1";

function Harness() {
  useSeedLiveVoiceSnapshot();
  return null;
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useConversationStore.getState().reset();
  useChatSessionStore.setState({ snapshot: null });
  useConversationStore.getState().setActiveConversationId(DRAFT_CONVERSATION_ID);
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useConversationStore.getState().reset();
  useChatSessionStore.setState({ snapshot: null });
});

describe("useSeedLiveVoiceSnapshot", () => {
  test("seeds an empty snapshot when the viewed conversation owns a session and none is seeded", () => {
    seedLiveVoiceSession("listening", {
      assistantId: ASSISTANT_ID,
      conversationId: DRAFT_CONVERSATION_ID,
    });
    render(<Harness />);

    const snapshot = useChatSessionStore.getState().snapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.messages).toEqual([]);
    expect(snapshot?.seq).toBeNull();
  });

  test("leaves an already-seeded snapshot untouched (no clobber of existing history)", () => {
    useChatSessionStore.getState().seedSnapshot(DRAFT_CONVERSATION_ID, {
      messages: [],
      seq: 1,
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
      processing: undefined,
    });
    const before = useChatSessionStore.getState().snapshot;

    seedLiveVoiceSession("listening", {
      assistantId: ASSISTANT_ID,
      conversationId: DRAFT_CONVERSATION_ID,
    });
    render(<Harness />);

    // Same object identity — the hook did not re-seed over existing history.
    expect(useChatSessionStore.getState().snapshot).toBe(before);
  });

  test("does not seed when the viewed conversation does not own the session", () => {
    seedLiveVoiceSession("listening", {
      assistantId: ASSISTANT_ID,
      conversationId: "conv-other-thread",
    });
    // Viewing the draft while the session belongs to another conversation.
    useConversationStore
      .getState()
      .setActiveConversationId(DRAFT_CONVERSATION_ID);
    render(<Harness />);

    expect(useChatSessionStore.getState().snapshot).toBeNull();
  });

  test("does not seed when there is no active live-voice session", () => {
    render(<Harness />);
    expect(useChatSessionStore.getState().snapshot).toBeNull();
  });
});
