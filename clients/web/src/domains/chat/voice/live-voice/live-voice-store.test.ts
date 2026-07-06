/**
 * Tests for the live-voice store's session context, shared controls, and
 * starter — the seams that let globally mounted surfaces (the title-bar
 * session pill) and the composer observe and drive a session owned by the
 * layout-mounted controller — plus the session-ownership predicates.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  isLiveVoiceSessionActive,
  isLiveVoiceSessionOwnedBy,
  useLiveVoiceStore,
  type LiveVoiceSessionControls,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

function makeControls(): LiveVoiceSessionControls {
  return { stop: mock(() => {}), release: mock(() => {}), interrupt: mock(() => {}) };
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  // reset() deliberately preserves the starter (mount-scoped); clear it
  // explicitly so tests can't leak a registered starter into each other.
  useLiveVoiceStore.getState().setStarter(null);
});

describe("useLiveVoiceStore — session context", () => {
  test("defaults to null assistant/conversation when idle", () => {
    expect(useLiveVoiceStore.getState().assistantId).toBeNull();
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
    expect(useLiveVoiceStore.getState().startedConversationId).toBeNull();
  });

  test("setSessionContext records the owning assistant and conversation", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    expect(useLiveVoiceStore.getState().assistantId).toBe("assistant-1");
    expect(useLiveVoiceStore.getState().conversationId).toBe("conv-1");
    expect(useLiveVoiceStore.getState().startedConversationId).toBe("conv-1");
  });

  test("setSessionContext accepts a null conversation", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", null);
    expect(useLiveVoiceStore.getState().assistantId).toBe("assistant-1");
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
    expect(useLiveVoiceStore.getState().startedConversationId).toBeNull();
  });

  test("setConversationId republishes the authoritative id without touching the started id", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", null);
    useLiveVoiceStore.getState().setConversationId("conv-server-assigned");
    expect(useLiveVoiceStore.getState().conversationId).toBe(
      "conv-server-assigned",
    );
    expect(useLiveVoiceStore.getState().startedConversationId).toBeNull();
  });

  test("reset clears the session context", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().assistantId).toBeNull();
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
    expect(useLiveVoiceStore.getState().startedConversationId).toBeNull();
  });
});

describe("useLiveVoiceStore — session starter", () => {
  test("defaults to null when no controller is mounted", () => {
    expect(useLiveVoiceStore.getState().starter).toBeNull();
  });

  test("setStarter registers and deregisters the controller's starter", () => {
    const starter = mock(() => {});
    useLiveVoiceStore.getState().setStarter(starter);
    expect(useLiveVoiceStore.getState().starter).toBe(starter);
    useLiveVoiceStore.getState().setStarter(null);
    expect(useLiveVoiceStore.getState().starter).toBeNull();
  });

  test("reset preserves the starter — session teardown must not deregister the mounted controller", () => {
    const starter = mock(() => {});
    useLiveVoiceStore.getState().setStarter(starter);
    // Simulate a full session lifecycle ending in teardown's reset().
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().starter).toBe(starter);
  });
});

describe("isLiveVoiceSessionActive", () => {
  test("false for idle and failed, true for every live phase", () => {
    expect(isLiveVoiceSessionActive("idle")).toBe(false);
    expect(isLiveVoiceSessionActive("failed")).toBe(false);
    const live: LiveVoiceSessionState[] = [
      "connecting",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "ending",
    ];
    for (const state of live) {
      expect(isLiveVoiceSessionActive(state)).toBe(true);
    }
  });
});

describe("isLiveVoiceSessionOwnedBy", () => {
  const session = (
    state: LiveVoiceSessionState,
    conversationId: string | null,
    startedConversationId: string | null,
  ) => ({ state, conversationId, startedConversationId });

  test("no ownership without an active session, even with matching ids", () => {
    expect(isLiveVoiceSessionOwnedBy(session("idle", "conv-1", "conv-1"), "conv-1")).toBe(false);
    expect(isLiveVoiceSessionOwnedBy(session("failed", "conv-1", "conv-1"), "conv-1")).toBe(false);
  });

  test("composer bound to the session's conversation owns it", () => {
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-1", "conv-1"), "conv-1"),
    ).toBe(true);
  });

  test("composer bound to a different conversation does not own it", () => {
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-1", "conv-1"), "conv-other"),
    ).toBe(false);
  });

  test("draft composer owns a draft-started session before AND after the server assigns a conversation", () => {
    // Before `ready`: the session has no conversation yet.
    expect(
      isLiveVoiceSessionOwnedBy(session("connecting", null, null), undefined),
    ).toBe(true);
    // After `ready`: authoritative id assigned, started id stays null — the
    // draft composer (still bound to no conversation) keeps owning it.
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-server", null), undefined),
    ).toBe(true);
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-server", null), null),
    ).toBe(true);
    // A composer bound to some other thread never picks it up.
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-server", null), "conv-other"),
    ).toBe(false);
    // Navigating to the assigned conversation makes that composer the owner.
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-server", null), "conv-server"),
    ).toBe(true);
  });

  test("draft composer does not own a session started with a conversation", () => {
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-1", "conv-1"), null),
    ).toBe(false);
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-1", "conv-1"), undefined),
    ).toBe(false);
  });
});

describe("useLiveVoiceStore — session controls", () => {
  test("defaults to null controls when idle", () => {
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });

  test("setControls registers the owning controller's controls", () => {
    const controls = makeControls();
    useLiveVoiceStore.getState().setControls(controls);
    expect(useLiveVoiceStore.getState().controls).toBe(controls);
  });

  test("setControls(null) deregisters controls", () => {
    useLiveVoiceStore.getState().setControls(makeControls());
    useLiveVoiceStore.getState().setControls(null);
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });

  test("reset clears registered controls", () => {
    useLiveVoiceStore.getState().setControls(makeControls());
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });
});
