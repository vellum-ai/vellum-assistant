/**
 * Tests for the live-voice store's session context, shared controls, and
 * starter — the seams that let globally mounted surfaces (the title-bar
 * session pill) and the composer observe and drive a session owned by the
 * layout-mounted controller — plus the session-ownership predicates.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeControlsSpies } from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import {
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  expandLiveVoiceRoom,
  getLiveVoiceInputAmplitude,
  isLiveVoiceMicLive,
  isLiveVoiceSessionActive,
  isLiveVoiceSessionOwnedBy,
  liveVoiceStateLabel,
  minimizeLiveVoiceRoom,
  releaseLiveVoiceTurn,
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

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

describe("useLiveVoiceStore — reconnecting", () => {
  test("defaults to false when idle", () => {
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);
  });

  test("setReconnecting toggles the flag", () => {
    useLiveVoiceStore.getState().setReconnecting(true);
    expect(useLiveVoiceStore.getState().reconnecting).toBe(true);
    useLiveVoiceStore.getState().setReconnecting(false);
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);
  });

  test("reset clears the reconnecting flag", () => {
    useLiveVoiceStore.getState().setReconnecting(true);
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().reconnecting).toBe(false);
  });
});

describe("useLiveVoiceStore — room minimize", () => {
  test("defaults to expanded", () => {
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
  });

  test("the module-level helpers minimize and re-expand the room", () => {
    minimizeLiveVoiceRoom();
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(true);
    expandLiveVoiceRoom();
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
  });

  test("reset clears a minimized room", () => {
    minimizeLiveVoiceRoom();
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
  });

  test("setSessionContext re-expands — a fresh session always opens with the room", () => {
    minimizeLiveVoiceRoom();
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
  });
});

describe("liveVoiceStateLabel", () => {
  test("relabels only the connecting phase while reconnecting", () => {
    expect(liveVoiceStateLabel("connecting", true)).toBe("Reconnecting…");
    expect(liveVoiceStateLabel("connecting", false)).toBe("Connecting…");
    // reconnecting is ignored for every other phase.
    expect(liveVoiceStateLabel("listening", true)).toBe("Listening…");
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
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);
    expect(useLiveVoiceStore.getState().controls).toBe(controls);
  });

  test("setControls(null) deregisters controls", () => {
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    useLiveVoiceStore.getState().setControls(null);
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });

  test("reset clears registered controls", () => {
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().controls).toBeNull();
  });
});

describe("endLiveVoiceSession / releaseLiveVoiceTurn", () => {
  test("route to the registered controls (and only the matching verb)", () => {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);

    endLiveVoiceSession();
    expect(controls.stop).toHaveBeenCalledTimes(1);
    expect(controls.release).not.toHaveBeenCalled();

    releaseLiveVoiceTurn();
    expect(controls.release).toHaveBeenCalledTimes(1);
    expect(controls.stop).toHaveBeenCalledTimes(1);
    expect(controls.interrupt).not.toHaveBeenCalled();
  });

  test("no-op when no controls are registered", () => {
    expect(useLiveVoiceStore.getState().controls).toBeNull();
    expect(() => {
      endLiveVoiceSession();
      releaseLiveVoiceTurn();
    }).not.toThrow();
  });
});

describe("dismissLiveVoiceFailure", () => {
  test("resets a failed session back to idle and clears the error", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    useLiveVoiceStore.getState().fail("boom");

    dismissLiveVoiceFailure();

    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(useLiveVoiceStore.getState().error).toBeNull();
    expect(useLiveVoiceStore.getState().assistantId).toBeNull();
    expect(useLiveVoiceStore.getState().conversationId).toBeNull();
  });

  test("preserves the mount-scoped starter, like any reset", () => {
    const starter = mock(() => {});
    useLiveVoiceStore.getState().setStarter(starter);
    useLiveVoiceStore.getState().fail("boom");

    dismissLiveVoiceFailure();

    expect(useLiveVoiceStore.getState().starter).toBe(starter);
  });
});

describe("isLiveVoiceMicLive", () => {
  test("true for the whole listening→speaking span (amplitude keeps flowing for barge-in)", () => {
    const micLive: LiveVoiceSessionState[] = [
      "listening",
      "transcribing",
      "thinking",
      "speaking",
    ];
    for (const state of micLive) {
      expect(isLiveVoiceMicLive(state)).toBe(true);
    }
  });

  test("false before capture starts and during/after teardown", () => {
    const micOff: LiveVoiceSessionState[] = ["idle", "connecting", "ending", "failed"];
    for (const state of micOff) {
      expect(isLiveVoiceMicLive(state)).toBe(false);
    }
  });
});

describe("getLiveVoiceInputAmplitude", () => {
  test("reads the store's current amplitude", () => {
    expect(getLiveVoiceInputAmplitude()).toBe(0);
    useLiveVoiceStore.getState().setInputAmplitude(0.42);
    expect(getLiveVoiceInputAmplitude()).toBe(0.42);
  });
});
