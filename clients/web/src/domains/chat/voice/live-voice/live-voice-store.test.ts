/**
 * Tests for the live-voice store's session context, shared controls, and
 * starter — the seams that let globally mounted surfaces (the title-bar
 * session pill) and the composer observe and drive a session owned by the
 * layout-mounted controller — plus the session-ownership predicates.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeControlsSpies } from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import {
  attachLiveVoiceFrame,
  attachLiveVoiceImage,
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoicePlaybackProgress,
  isLiveVoiceMicLive,
  isLiveVoiceSessionActive,
  isLiveVoiceSessionOwnedBy,
  LIVE_VOICE_STATE_KEYS,
  liveVoiceSurfaceLabelKey,
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
import enChat from "@/i18n/locales/en/chat.json";

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

/**
 * What a surface renders for a session in English: the key the resolver
 * returns, read out of the catalog every surface reads it out of.
 */
function surfaceLabel(
  state: LiveVoiceSessionState,
  reconnecting: boolean,
  assistantAudioActive: boolean,
  muted: boolean,
): string {
  const key = liveVoiceSurfaceLabelKey(
    state,
    reconnecting,
    assistantAudioActive,
    muted,
  );
  if (!key) {
    return "";
  }
  const slot = key.replace("liveVoiceStatus.", "");
  return enChat.liveVoiceStatus[slot as keyof typeof enChat.liveVoiceStatus];
}

describe("LIVE_VOICE_STATE_KEYS", () => {
  /**
   * `toVoiceAvatarVisual` collapses `transcribing` into `thinking`, so a key of
   * its own put two different words for one phase on screen at once: the
   * avatar and eyes caption reading thinking, the label reading transcribing.
   */
  test("gives transcribing no wording of its own", () => {
    expect(LIVE_VOICE_STATE_KEYS.transcribing).toBe(
      LIVE_VOICE_STATE_KEYS.thinking,
    );
  });

  /** The collapse is the wording's, not the phase's: the state still exists. */
  test("keeps transcribing a distinct session state", () => {
    expect(toVoiceAvatarVisual("transcribing", false)).toBe(
      toVoiceAvatarVisual("thinking", false),
    );
    expect(surfaceLabel("transcribing", false, true, false)).toBe("Thinking…");
  });
});

describe("liveVoiceSurfaceLabelKey", () => {
  test("a speaking phase with no audio playing reads as thinking", () => {
    // `speaking` stays set across a mid-turn tool run (the ack was spoken and
    // the assistant is now silent) so every surface says "Thinking…".
    expect(surfaceLabel("speaking", false, false, false)).toBe("Thinking…");
    expect(surfaceLabel("speaking", false, true, false)).toBe("Speaking…");
  });

  test("carries the reconnecting relabel through unchanged", () => {
    expect(surfaceLabel("connecting", true, false, false)).toBe(
      "Reconnecting…",
    );
    expect(surfaceLabel("listening", false, false, false)).toBe("Listening…");
    // Only `connecting` reads the signal: a retry that has already reconnected
    // far enough to listen is listening.
    expect(surfaceLabel("listening", true, false, false)).toBe("Listening…");
  });

  /**
   * The session holds `listening` while the mic is muted, so an unremapped
   * surface claims to be listening beside a mute button that says it is not.
   */
  test("a muted listening phase reads as muted", () => {
    expect(surfaceLabel("listening", false, false, true)).toBe("Muted");
  });

  /** A state rather than an activity, so no ellipsis where the phases have one. */
  test("says muted without an ellipsis", () => {
    expect(surfaceLabel("listening", false, false, true)).not.toContain("…");
  });

  /**
   * Muting the microphone does not make the assistant stop thinking or
   * speaking, so relabelling those would trade one false statement for another.
   */
  test("leaves the assistant's own phases alone while muted", () => {
    expect(surfaceLabel("thinking", false, false, true)).toBe("Thinking…");
    expect(surfaceLabel("speaking", false, true, true)).toBe("Speaking…");
    expect(surfaceLabel("transcribing", false, false, true)).toBe("Thinking…");
  });

  /**
   * Reconnecting is the more urgent fact: a muted mic matters less than a
   * session that is not currently connected at all.
   */
  test("does not hide a reconnect behind the mute", () => {
    expect(surfaceLabel("connecting", true, false, true)).toBe("Reconnecting…");
  });

  /**
   * The key table is the only source of session wording, so a key naming a
   * message the catalog does not carry leaves every surface rendering the key
   * itself, the island and the macOS companion included.
   */
  test("keys copy the catalog actually carries", () => {
    const cases: [LiveVoiceSessionState, boolean, boolean, boolean][] = [
      ["connecting", false, false, false],
      ["connecting", true, false, false],
      ["listening", false, false, false],
      ["listening", false, false, true],
      ["transcribing", false, false, false],
      ["thinking", false, false, false],
      ["speaking", false, true, false],
      ["speaking", false, false, false],
      ["ending", false, false, false],
    ];

    for (const [state, reconnecting, audio, muted] of cases) {
      expect(
        liveVoiceSurfaceLabelKey(state, reconnecting, audio, muted),
      ).not.toBeNull();
      expect(surfaceLabel(state, reconnecting, audio, muted)).toBeTruthy();
    }
  });

  /** Hosts unmount their voice UI in these phases, so there is no word to key. */
  test("keys nothing for the phases that carry no word", () => {
    expect(liveVoiceSurfaceLabelKey("idle", false, false, false)).toBeNull();
    expect(liveVoiceSurfaceLabelKey("failed", false, false, false)).toBeNull();
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

describe("attachLiveVoiceImage", () => {
  test("delivers a photo pressed in the session that still runs", () => {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);
    const pressed = useLiveVoiceStore.getState().sessionGeneration;

    expect(attachLiveVoiceImage("att-1", pressed)).toBe(true);
    expect(controls.attachImage).toHaveBeenCalledWith("att-1");
  });

  test("refuses a photo pressed in a session that ended", () => {
    // The upload outlives the session: the press happens in one session, the
    // id arrives after a reset and a fresh session's controls are registered.
    // The successor must not receive the predecessor's photo.
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    const pressed = useLiveVoiceStore.getState().sessionGeneration;

    useLiveVoiceStore.getState().reset();
    const successor = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(successor);

    expect(attachLiveVoiceImage("att-1", pressed)).toBe(false);
    expect(successor.attachImage).not.toHaveBeenCalled();
  });

  test("survives a reconnect's republished controls within one session", () => {
    // Reconnect attempts republish a fresh controls object without a reset,
    // so the generation is what tells "same session, new transport" apart
    // from "new session".
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    const pressed = useLiveVoiceStore.getState().sessionGeneration;

    const republished = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(republished);

    expect(attachLiveVoiceImage("att-1", pressed)).toBe(true);
    expect(republished.attachImage).toHaveBeenCalledWith("att-1");
  });

  test("survives the reconnect path's own mid-session reset", () => {
    // The reconnect flow re-enters its connect sequence, which resets the
    // store with `sessionContinues` before registering fresh controls. The
    // logical session goes on, so a photo pressed before the blip still
    // lands after it.
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    const pressed = useLiveVoiceStore.getState().sessionGeneration;

    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    const reconnected = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(reconnected);

    expect(attachLiveVoiceImage("att-1", pressed)).toBe(true);
    expect(reconnected.attachImage).toHaveBeenCalledWith("att-1");
  });
});

describe("attachLiveVoiceFrame", () => {
  test("parks a frame sampled in the session that still runs", () => {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);
    const sampled = useLiveVoiceStore.getState().sessionGeneration;

    expect(attachLiveVoiceFrame("att-1", sampled)).toBe(true);
    expect(controls.attachFrame).toHaveBeenCalledWith("att-1");
  });

  test("refuses a frame sampled in a session that ended", () => {
    // Same rule as a photo's, and it matters more here: nobody pressed
    // anything, so a frame landing in the wrong call would show the assistant
    // a view from a conversation the user has already left.
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    const sampled = useLiveVoiceStore.getState().sessionGeneration;

    useLiveVoiceStore.getState().reset();
    const successor = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(successor);

    expect(attachLiveVoiceFrame("att-1", sampled)).toBe(false);
    expect(successor.attachFrame).not.toHaveBeenCalled();
  });

  test("reports false when no session has registered controls", () => {
    expect(
      attachLiveVoiceFrame(
        "att-1",
        useLiveVoiceStore.getState().sessionGeneration,
      ),
    ).toBe(false);
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

describe("useLiveVoiceStore: utteranceOpen", () => {
  test("closed until the server VAD opens an utterance", () => {
    expect(useLiveVoiceStore.getState().utteranceOpen).toBe(false);
    useLiveVoiceStore.getState().setUtteranceOpen(true);
    expect(useLiveVoiceStore.getState().utteranceOpen).toBe(true);
  });

  test("closes again when the utterance ends or is discarded", () => {
    useLiveVoiceStore.getState().setUtteranceOpen(true);
    useLiveVoiceStore.getState().setUtteranceOpen(false);
    expect(useLiveVoiceStore.getState().utteranceOpen).toBe(false);
  });

  test("reset closes it with the rest of the session", () => {
    // Session-scoped: an utterance open when the session ends must not read as
    // the user talking into the next one.
    useLiveVoiceStore.getState().setUtteranceOpen(true);
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().utteranceOpen).toBe(false);
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
