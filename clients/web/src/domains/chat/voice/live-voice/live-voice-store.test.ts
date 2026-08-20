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
  getLiveVoiceInputAmplitude,
  getLiveVoicePlaybackProgress,
  isLiveVoiceMicLive,
  isLiveVoiceSessionActive,
  isLiveVoiceSessionOwnedBy,
  LIVE_VOICE_STATE_LABELS,
  liveVoiceStateLabel,
  liveVoiceSurfaceLabel,
  minimizeVoiceRoom,
  releaseLiveVoiceTurn,
  restoreVoiceRoom,
  setLiveVoiceMuted,
  stopLiveVoiceResponse,
  subscribeSettledLiveVoiceState,
  updateLiveVoiceSessionConfig,
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { toVoiceAvatarVisual } from "@/domains/chat/voice/voice-room/voice-avatar-state";

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  // reset() deliberately preserves the starter (mount-scoped); clear it
  // explicitly so tests can't leak a registered starter into each other.
  useLiveVoiceStore.getState().setStarter(null);
});

function makeStarter() {
  return {
    prewarm: mock(() => {}),
    cancelPrewarm: mock(() => {}),
    start: mock((_assistantId: string, _conversationId: string | null) => {}),
  };
}

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
    const starter = makeStarter();
    useLiveVoiceStore.getState().setStarter(starter);
    expect(useLiveVoiceStore.getState().starter).toBe(starter);
    useLiveVoiceStore.getState().setStarter(null);
    expect(useLiveVoiceStore.getState().starter).toBeNull();
  });

  test("reset preserves the starter — session teardown must not deregister the mounted controller", () => {
    const starter = makeStarter();
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

describe("useLiveVoiceStore — mute + handsFree", () => {
  test("defaults: mic live, not hands-free", () => {
    expect(useLiveVoiceStore.getState().muted).toBe(false);
    expect(useLiveVoiceStore.getState().handsFree).toBe(false);
  });

  test("setLiveVoiceMuted drives the registered control", () => {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);
    setLiveVoiceMuted(true);
    expect(controls.setMuted).toHaveBeenCalledWith(true);
    setLiveVoiceMuted(false);
    expect(controls.setMuted).toHaveBeenCalledWith(false);
  });

  test("stopLiveVoiceResponse drives the registered interrupt control", () => {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);
    stopLiveVoiceResponse();
    expect(controls.interrupt).toHaveBeenCalledTimes(1);
  });

  test("updateLiveVoiceSessionConfig drives the registered updateConfig control", () => {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);
    updateLiveVoiceSessionConfig({ silenceThresholdMs: 1500 });
    expect(controls.updateConfig).toHaveBeenCalledWith({
      silenceThresholdMs: 1500,
    });
  });

  test("helpers are no-ops with no registered controls", () => {
    expect(() => {
      setLiveVoiceMuted(true);
      stopLiveVoiceResponse();
      updateLiveVoiceSessionConfig({ silenceThresholdMs: 1500 });
    }).not.toThrow();
  });

  test("reset clears muted and handsFree; setSessionContext unmutes a fresh session", () => {
    useLiveVoiceStore.getState().setMuted(true);
    useLiveVoiceStore.getState().setHandsFree(true);
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().muted).toBe(false);
    expect(useLiveVoiceStore.getState().handsFree).toBe(false);

    useLiveVoiceStore.getState().setMuted(true);
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    expect(useLiveVoiceStore.getState().muted).toBe(false);
  });
});

describe("useLiveVoiceStore — room minimize", () => {
  test("defaults to not minimized — a new session opens in the room", () => {
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
  });

  test("minimizeVoiceRoom sets the flag during an active session", () => {
    useLiveVoiceStore.getState().setState("listening");
    minimizeVoiceRoom();
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(true);
  });

  test("minimizeVoiceRoom no-ops when idle", () => {
    minimizeVoiceRoom();
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
  });

  test("restoreVoiceRoom clears the flag", () => {
    useLiveVoiceStore.getState().setState("listening");
    minimizeVoiceRoom();
    restoreVoiceRoom();
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
  });

  test("reset restores roomMinimized to false — a new session always opens in the room", () => {
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
    useLiveVoiceStore.getState().setState("listening");
    minimizeVoiceRoom();
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(true);
    useLiveVoiceStore.getState().reset();
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

describe("LIVE_VOICE_STATE_LABELS", () => {
  /**
   * `toVoiceAvatarVisual` collapses `transcribing` into `thinking`, so a label
   * of its own put two different words for one phase on screen at once: the
   * avatar and eyes caption reading thinking, the label reading transcribing.
   */
  test("gives transcribing no wording of its own", () => {
    expect(LIVE_VOICE_STATE_LABELS.transcribing).toBe(
      LIVE_VOICE_STATE_LABELS.thinking,
    );
  });

  /** The collapse is the label's, not the phase's: the state still exists. */
  test("keeps transcribing a distinct session state", () => {
    expect(toVoiceAvatarVisual("transcribing", false)).toBe(
      toVoiceAvatarVisual("thinking", false),
    );
    expect(liveVoiceStateLabel("transcribing", false)).toBe("Thinking…");
  });
});

describe("liveVoiceSurfaceLabel", () => {
  test("a speaking phase with no audio playing reads as thinking", () => {
    // `speaking` stays set across a mid-turn tool run (the ack was spoken and
    // the assistant is now silent) so every surface says "Thinking…".
    expect(liveVoiceSurfaceLabel("speaking", false, false, false)).toBe(
      "Thinking…",
    );
    expect(liveVoiceSurfaceLabel("speaking", false, true, false)).toBe(
      "Speaking…",
    );
  });

  test("carries the reconnecting relabel through unchanged", () => {
    expect(liveVoiceSurfaceLabel("connecting", true, false, false)).toBe(
      "Reconnecting…",
    );
    expect(liveVoiceSurfaceLabel("listening", false, false, false)).toBe(
      "Listening…",
    );
  });

  /**
   * The session holds `listening` while the mic is muted, so an unremapped
   * surface claims to be listening beside a mute button that says it is not.
   */
  test("a muted listening phase reads as muted", () => {
    expect(liveVoiceSurfaceLabel("listening", false, false, true)).toBe(
      "Muted",
    );
  });

  /** A state rather than an activity, so no ellipsis where the phases have one. */
  test("says muted without an ellipsis", () => {
    expect(liveVoiceSurfaceLabel("listening", false, false, true)).not.toContain(
      "\u2026",
    );
  });

  /**
   * Muting the microphone does not make the assistant stop thinking or
   * speaking, so relabelling those would trade one false statement for another.
   */
  test("leaves the assistant's own phases alone while muted", () => {
    expect(liveVoiceSurfaceLabel("thinking", false, false, true)).toBe(
      "Thinking…",
    );
    expect(liveVoiceSurfaceLabel("speaking", false, true, true)).toBe(
      "Speaking…",
    );
    expect(liveVoiceSurfaceLabel("transcribing", false, false, true)).toBe(
      "Thinking…",
    );
  });

  /**
   * Reconnecting is the more urgent fact: a muted mic matters less than a
   * session that is not currently connected at all.
   */
  test("does not hide a reconnect behind the mute", () => {
    expect(liveVoiceSurfaceLabel("connecting", true, false, true)).toBe(
      "Reconnecting…",
    );
  });
});

describe("subscribeSettledLiveVoiceState", () => {
  test("a superseded state never reaches the listener", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSettledLiveVoiceState((s) =>
      seen.push(s.state),
    );

    // The reconnect burst: `connectSession` resets (landing on `idle`) and
    // immediately rebuilds the session as `connecting`. A raw
    // `useLiveVoiceStore.subscribe` would report the `idle`, and the consumers
    // that drive the native audio session and the Live Activity would act on
    // it — tearing both down and re-creating them on every retry.
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().reset();
    useLiveVoiceStore.getState().setState("connecting");
    useLiveVoiceStore.getState().setReconnecting(true);

    return Promise.resolve().then(() => {
      unsubscribe();
      expect(seen).toEqual(["connecting"]);
    });
  });

  test("stops delivering once unsubscribed, even mid-burst", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSettledLiveVoiceState((s) =>
      seen.push(s.state),
    );

    useLiveVoiceStore.getState().setState("listening");
    unsubscribe();

    return Promise.resolve().then(() => {
      expect(seen).toEqual([]);
    });
  });

  test("delivers each settled transition once", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSettledLiveVoiceState((s) =>
      seen.push(s.state),
    );

    useLiveVoiceStore.getState().setState("connecting");
    await Promise.resolve();
    useLiveVoiceStore.getState().setState("listening");
    await Promise.resolve();
    unsubscribe();

    expect(seen).toEqual(["connecting", "listening"]);
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
    expect(
      isLiveVoiceSessionOwnedBy(session("idle", "conv-1", "conv-1"), "conv-1"),
    ).toBe(false);
    expect(
      isLiveVoiceSessionOwnedBy(
        session("failed", "conv-1", "conv-1"),
        "conv-1",
      ),
    ).toBe(false);
  });

  test("composer bound to the session's conversation owns it", () => {
    expect(
      isLiveVoiceSessionOwnedBy(
        session("listening", "conv-1", "conv-1"),
        "conv-1",
      ),
    ).toBe(true);
  });

  test("composer bound to a different conversation does not own it", () => {
    expect(
      isLiveVoiceSessionOwnedBy(
        session("listening", "conv-1", "conv-1"),
        "conv-other",
      ),
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
      isLiveVoiceSessionOwnedBy(
        session("listening", "conv-server", null),
        undefined,
      ),
    ).toBe(true);
    expect(
      isLiveVoiceSessionOwnedBy(
        session("listening", "conv-server", null),
        null,
      ),
    ).toBe(true);
    // A composer bound to some other thread never picks it up.
    expect(
      isLiveVoiceSessionOwnedBy(
        session("listening", "conv-server", null),
        "conv-other",
      ),
    ).toBe(false);
    // Navigating to the assigned conversation makes that composer the owner.
    expect(
      isLiveVoiceSessionOwnedBy(
        session("listening", "conv-server", null),
        "conv-server",
      ),
    ).toBe(true);
  });

  test("draft composer does not own a session started with a conversation", () => {
    expect(
      isLiveVoiceSessionOwnedBy(session("listening", "conv-1", "conv-1"), null),
    ).toBe(false);
    expect(
      isLiveVoiceSessionOwnedBy(
        session("listening", "conv-1", "conv-1"),
        undefined,
      ),
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
    const starter = makeStarter();
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
    const micOff: LiveVoiceSessionState[] = [
      "idle",
      "connecting",
      "ending",
      "failed",
    ];
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

describe("useLiveVoiceStore — playback-progress provider", () => {
  test("defaults to null when idle", () => {
    expect(useLiveVoiceStore.getState().playbackProgressProvider).toBeNull();
  });

  test("setPlaybackProgressProvider registers and deregisters the provider", () => {
    const provider = mock(() => null);
    useLiveVoiceStore.getState().setPlaybackProgressProvider(provider);
    expect(useLiveVoiceStore.getState().playbackProgressProvider).toBe(
      provider,
    );
    useLiveVoiceStore.getState().setPlaybackProgressProvider(null);
    expect(useLiveVoiceStore.getState().playbackProgressProvider).toBeNull();
  });

  test("reset clears the registered provider", () => {
    useLiveVoiceStore.getState().setPlaybackProgressProvider(() => null);
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().playbackProgressProvider).toBeNull();
  });

  test("getLiveVoicePlaybackProgress returns null with no provider", () => {
    expect(getLiveVoicePlaybackProgress()).toBeNull();
  });

  test("getLiveVoicePlaybackProgress forwards the provider's value", () => {
    const progress = { playedSeconds: 1.5, totalSeconds: 4 };
    useLiveVoiceStore.getState().setPlaybackProgressProvider(() => progress);
    expect(getLiveVoicePlaybackProgress()).toBe(progress);

    useLiveVoiceStore.getState().setPlaybackProgressProvider(() => null);
    expect(getLiveVoicePlaybackProgress()).toBeNull();
  });
});
