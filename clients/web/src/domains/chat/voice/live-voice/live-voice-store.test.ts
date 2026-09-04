/**
 * Tests for the live-voice store's session context, shared controls, and
 * starter — the seams that let globally mounted surfaces (the title-bar
 * session pill) and the composer observe and drive a session owned by the
 * layout-mounted controller — plus the session-ownership predicates.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { makeControlsSpies } from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import {
  attachLiveVoiceImage,
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoicePlaybackProgress,
  isLiveVoiceMicLive,
  isLiveVoiceSessionActive,
  isLiveVoiceSessionOwnedBy,
  isLiveVoiceUserSpeaking,
  LIVE_VOICE_STATE_KEYS,
  liveVoiceSurfaceLabelKey,
  minimizeVoiceRoom,
  releaseLiveVoiceTurn,
  PER_JOB_CEILING_MS,
  restoreVoiceRoom,
  sendLiveVoiceSightFrame,
  setLiveVoiceMuted,
  setLiveVoiceScreenShare,
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
  // It preserves the reclaim queue for the same kind of reason (a cleanup duty
  // that must outlive the session), so that needs draining here too.
  useLiveVoiceStore
    .getState()
    .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER);
});

afterEach(() => {
  setSystemTime();
});

/**
 * Park the clock and hand back the instant it now reads.
 *
 * The deadlines below are derived from a `Date.now()` the store reads for
 * itself, so a case that asserts one exactly has to agree with the store on
 * what "now" is. Parking the clock is that agreement: without it the two reads
 * straddle a millisecond boundary often enough to fail.
 */
function atAParkedClock(): number {
  const at = Date.now();
  setSystemTime(new Date(at));
  return at;
}

function makeStarter() {
  return {
    prewarm: mock(() => {}),
    cancelPrewarm: mock(() => {}),
    start: mock((_assistantId: string, _conversationId: string | null) => {}),
    sendText: mock((_text: string) => false),
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

describe("sendLiveVoiceSightFrame", () => {
  test("shares a frame kept in the session that still runs", () => {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(controls);
    const kept = useLiveVoiceStore.getState().sessionGeneration;

    expect(sendLiveVoiceSightFrame("att-1", kept)).toBe(true);
    expect(controls.sightFrame).toHaveBeenCalledWith("att-1");
  });

  test("refuses a frame kept in a session that ended", () => {
    // The daemon persists this into whichever conversation the session it
    // reaches is bound to, so a late upload landing in the successor would put
    // a view from a call the user has already left into a different one.
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    const kept = useLiveVoiceStore.getState().sessionGeneration;

    useLiveVoiceStore.getState().reset();
    const successor = makeControlsSpies();
    useLiveVoiceStore.getState().setControls(successor);

    expect(sendLiveVoiceSightFrame("att-1", kept)).toBe(false);
    expect(successor.sightFrame).not.toHaveBeenCalled();
  });

  test("reports false when no session has registered controls", () => {
    expect(
      sendLiveVoiceSightFrame(
        "att-1",
        useLiveVoiceStore.getState().sessionGeneration,
      ),
    ).toBe(false);
  });
});

describe("sight frame refusals", () => {
  /** Seed a session bound to an assistant, so reclaims name one. */
  function sightSession() {
    const controls = makeControlsSpies();
    useLiveVoiceStore.getState().setSessionContext("asst_sight", "conv_sight");
    useLiveVoiceStore.getState().setControls(controls);
    return {
      controls,
      generation: useLiveVoiceStore.getState().sessionGeneration,
    };
  }

  const reclaimed = () =>
    useLiveVoiceStore
      .getState()
      .sightFramesToReclaim.map((r) => r.attachmentId);

  test("an unsupported refusal latches the session and queues every id", () => {
    const { controls, generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    const state = useLiveVoiceStore.getState();
    expect(state.sightFramesUnsupported).toBe(true);
    // Every id in flight is the client's to give back: this assistant stored
    // none of them and reclaims nothing. The queue names the assistant so a
    // drain after the call still deletes against the right one.
    expect(state.sightFramesToReclaim).toEqual([
      { assistantId: "asst_sight", attachmentId: "att-1" },
    ]);
    // And nothing further is sent, which is the orphan-per-keep this closes.
    controls.sightFrame.mockClear();
    expect(sendLiveVoiceSightFrame("att-2", generation)).toBe(false);
    expect(controls.sightFrame).not.toHaveBeenCalled();
  });

  test("a routine refusal does not latch or queue anything", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(false);

    expect(useLiveVoiceStore.getState().sightFramesUnsupported).toBe(false);
    // The assistant reclaims what it could not persist, so deleting here would
    // race it over a row this client no longer owns.
    expect(reclaimed()).toEqual([]);
    expect(sendLiveVoiceSightFrame("att-2", generation)).toBe(true);
  });

  test("a lone outstanding keep's refusal retracts it", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(false);

    expect(useLiveVoiceStore.getState().sightFrameRetractions).toEqual([
      "att-1",
    ]);
  });

  test("a refusal with a newer keep behind it takes every claim down", () => {
    // Naming nothing, the refusal could be either keep. A persisted keep's
    // frame sits in the transcript whether its flash shows or not, while the
    // refused keep's flash claims a share that never happened, so every claim
    // it might be about comes down.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    sendLiveVoiceSightFrame("att-2", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(false);

    expect(useLiveVoiceStore.getState().sightFrameRetractions).toEqual([
      "att-1",
      "att-2",
    ]);
  });

  test("an unnamed refusal retires nothing, so reset reclaims every send", () => {
    // The refusal answered for one send without saying which. Guessing a
    // retirement would exempt that send from the reset-time reclaim, and the
    // link-aware delete there is what can actually tell them apart: it is
    // refused for the keep a message holds and collects the one that was
    // refused before it ever became one.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    sendLiveVoiceSightFrame("att-2", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(false);
    expect(useLiveVoiceStore.getState().outstandingSightFrames).toEqual([
      "att-1",
      "att-2",
    ]);

    useLiveVoiceStore.getState().reset();

    expect(reclaimed()).toEqual(["att-1", "att-2"]);
  });

  test("an echoed attachment id retracts exactly, past older sends", () => {
    // What the fallback cannot do. Successful keeps are answered with nothing,
    // so the ledger keeps filling and the positional rule goes quiet for the
    // rest of the call; an id on the error frame is decidable whatever else is
    // outstanding.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    sendLiveVoiceSightFrame("att-2", generation);
    sendLiveVoiceSightFrame("att-3", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(false, "att-3");

    const state = useLiveVoiceStore.getState();
    expect(state.sightFrameRetractions).toEqual(["att-3"]);
    // Retired exactly, wherever it sat, rather than by position.
    expect(state.outstandingSightFrames).toEqual(["att-1", "att-2"]);
  });

  test("retractions accumulate until the surface consumes them", () => {
    // A second refusal re-answers for the same unretired ledger; the set is
    // what keeps it from duplicating the first answer, and appending rather
    // than overwriting is what keeps it from erasing one not yet consumed.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(false);
    useLiveVoiceStore.getState().noteSightFrameRefused(false);

    expect(useLiveVoiceStore.getState().sightFrameRetractions).toEqual([
      "att-1",
    ]);
  });

  test("reclaims accumulate across refusals nobody has drained", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    sendLiveVoiceSightFrame("att-2", generation);

    useLiveVoiceStore.getState().noteSightFrameRefused(true);
    useLiveVoiceStore.getState().noteSightFrameRefused(true, "att-3");

    expect(reclaimed()).toEqual(["att-1", "att-2", "att-3"]);
  });

  test("the outstanding ledger is capped, and pruned ids still get reclaimed", () => {
    // The cap is memory hygiene: without it the ledger grows for the length of
    // a call, since an accepted keep is answered with nothing. A pruned id is
    // not forgotten, because an assistant that turns out to take nothing must
    // still give every upload back.
    const { generation } = sightSession();
    for (let i = 1; i <= 11; i++) {
      sendLiveVoiceSightFrame(`att-${i}`, generation);
    }

    expect(useLiveVoiceStore.getState().outstandingSightFrames).toEqual([
      "att-4",
      "att-5",
      "att-6",
      "att-7",
      "att-8",
      "att-9",
      "att-10",
      "att-11",
    ]);

    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    expect(reclaimed()).toEqual([
      "att-1",
      "att-2",
      "att-3",
      "att-4",
      "att-5",
      "att-6",
      "att-7",
      "att-8",
      "att-9",
      "att-10",
      "att-11",
    ]);
  });

  test("the reclaim queue survives the session that filled it", () => {
    // The case a room-owned drain cannot cover: minimized, the room is not
    // mounted, so the refusal lands with nobody to act on it and the call then
    // ends. A queue a teardown could discard would strand those uploads.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    useLiveVoiceStore.getState().reset();

    expect(reclaimed()).toEqual(["att-1"]);
  });

  test("reset-routed reclaims wait, refusal-routed ones do not", () => {
    // A refusal means the assistant is done with the frame. A reset means
    // nobody answered, and the daemon may still be about to persist it, so
    // that one waits for the link-aware delete to be able to tell them apart.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-refused", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(true);
    // Recorded directly: the latch refuses further sends, and what matters
    // here is a ledger entry nobody answered for sitting beside a refused one.
    useLiveVoiceStore.getState().noteSightFrameSent("att-unanswered");

    useLiveVoiceStore.getState().reset();

    const queue = useLiveVoiceStore.getState().sightFramesToReclaim;
    expect(queue.find((e) => e.attachmentId === "att-refused")?.notBefore).toBe(
      undefined,
    );
    expect(
      queue.find((e) => e.attachmentId === "att-unanswered")?.notBefore,
    ).toBeGreaterThan(Date.now());
  });

  test("the deadline scales with what can be queued ahead", () => {
    // The daemon runs standalone persists one at a time and never supersedes a
    // photo, so a keep can sit behind any number of them. This client is the
    // only producer of that queue, so its own ledgers are the count.
    const { generation } = sightSession();
    attachLiveVoiceImage("photo-1", generation);
    attachLiveVoiceImage("photo-2", generation);
    attachLiveVoiceImage("photo-3", generation);
    sendLiveVoiceSightFrame("att-1", generation);
    const at = atAParkedClock();

    useLiveVoiceStore.getState().reset();

    // Three photos and one keep ahead, plus the job itself.
    const entry = useLiveVoiceStore.getState().sightFramesToReclaim[0];
    expect(entry?.notBefore).toBe(at + 5 * PER_JOB_CEILING_MS);
  });

  test("a shorter queue yields a shorter deadline", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    const at = atAParkedClock();

    useLiveVoiceStore.getState().reset();

    expect(
      useLiveVoiceStore.getState().sightFramesToReclaim[0]?.notBefore,
    ).toBe(at + 2 * PER_JOB_CEILING_MS);
  });

  test("the deadline keeps scaling however long the queue got", () => {
    // 400 photos ahead is over three hours of serialized persists. The delete
    // waits all of it out: any shorter deadline can fire while the persist is
    // still queued and take the frame with it.
    const { generation } = sightSession();
    for (let i = 0; i < 400; i++) {
      attachLiveVoiceImage(`photo-${i}`, generation);
    }
    sendLiveVoiceSightFrame("att-1", generation);
    const at = atAParkedClock();

    useLiveVoiceStore.getState().reset();

    expect(
      useLiveVoiceStore.getState().sightFramesToReclaim[0]?.notBefore,
    ).toBe(at + 402 * PER_JOB_CEILING_MS);
  });

  test("a send after the reset pushes the waiting reclaims out", () => {
    // A reconnect's new photo lands BEHIND the jobs those reclaims are waiting
    // on, in the same conversation queue, so it moves their deadline with it.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    const before =
      useLiveVoiceStore.getState().sightFramesToReclaim[0]!.notBefore!;

    useLiveVoiceStore.getState().setSessionContext("asst_sight", "conv_sight");
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    attachLiveVoiceImage(
      "photo-after",
      useLiveVoiceStore.getState().sessionGeneration,
    );

    expect(
      useLiveVoiceStore.getState().sightFramesToReclaim[0]?.notBefore,
    ).toBe(before + PER_JOB_CEILING_MS);
  });

  test("a keep sent after the reset pushes them out too", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    const before =
      useLiveVoiceStore.getState().sightFramesToReclaim[0]!.notBefore!;

    useLiveVoiceStore.getState().setSessionContext("asst_sight", "conv_sight");
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    sendLiveVoiceSightFrame(
      "att-after",
      useLiveVoiceStore.getState().sessionGeneration,
    );

    expect(
      useLiveVoiceStore.getState().sightFramesToReclaim[0]?.notBefore,
    ).toBe(before + PER_JOB_CEILING_MS);
  });

  test("a send in another conversation moves no deadline", () => {
    // The daemon serializes persists per conversation, so a keep sent on a
    // later call in a different conversation lands behind nothing these
    // reclaims wait on. Steady keeps there must not hold this orphan's
    // deadline open for the length of that call.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    const before =
      useLiveVoiceStore.getState().sightFramesToReclaim[0]!.notBefore!;

    useLiveVoiceStore.getState().setSessionContext("asst_sight", "conv_other");
    useLiveVoiceStore.getState().setControls(makeControlsSpies());
    sendLiveVoiceSightFrame(
      "att-other",
      useLiveVoiceStore.getState().sessionGeneration,
    );

    expect(
      useLiveVoiceStore.getState().sightFramesToReclaim[0]?.notBefore,
    ).toBe(before);
  });

  test("a send never gives a refusal-routed reclaim a deadline", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    useLiveVoiceStore.getState().notePhotoSent();

    expect(
      useLiveVoiceStore.getState().sightFramesToReclaim[0]?.notBefore,
    ).toBeUndefined();
  });

  test("a refused photo stops counting toward the deadline", () => {
    const { generation } = sightSession();
    attachLiveVoiceImage("photo-1", generation);
    useLiveVoiceStore.getState().notePhotoRejected("failed");
    sendLiveVoiceSightFrame("att-1", generation);
    const at = atAParkedClock();

    useLiveVoiceStore.getState().reset();

    // The assistant answered for the photo, so only the keep is ahead.
    expect(
      useLiveVoiceStore.getState().sightFramesToReclaim[0]?.notBefore,
    ).toBe(at + 2 * PER_JOB_CEILING_MS);
  });

  test("taking leaves behind what is not due yet", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().reset();

    const takenEarly = useLiveVoiceStore
      .getState()
      .takeDueSightFrameReclaims(Date.now());

    expect(takenEarly).toEqual([]);
    expect(reclaimed()).toEqual(["att-1"]);

    const takenLate = useLiveVoiceStore
      .getState()
      .takeDueSightFrameReclaims(Date.now() + 2 * PER_JOB_CEILING_MS + 1);

    expect(takenLate.map((e) => e.attachmentId)).toEqual(["att-1"]);
    expect(reclaimed()).toEqual([]);
  });

  test("a take with nothing due leaves the queue's identity alone", () => {
    // The reclaimer keys on this array, so a no-op take that handed back a new
    // one would wake it in a loop.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().reset();
    const before = useLiveVoiceStore.getState().sightFramesToReclaim;

    useLiveVoiceStore.getState().takeDueSightFrameReclaims(Date.now());

    expect(useLiveVoiceStore.getState().sightFramesToReclaim).toBe(before);
  });

  test("a reconnect queues the sends nobody acknowledged", () => {
    // Reaching the transport says nothing about persistence. A socket that
    // closes between the send and the write takes the frame with it, and the
    // assistant answers nothing either way.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    sendLiveVoiceSightFrame("att-2", generation);

    useLiveVoiceStore.getState().reset({ sessionContinues: true });

    expect(reclaimed()).toEqual(["att-1", "att-2"]);
  });

  test("a terminal reset queues them the same way", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);

    useLiveVoiceStore.getState().reset();

    expect(reclaimed()).toEqual(["att-1"]);
  });

  test("pruned sends are queued at a reset too", () => {
    const { generation } = sightSession();
    for (let i = 1; i <= 10; i++) {
      sendLiveVoiceSightFrame(`att-${i}`, generation);
    }

    useLiveVoiceStore.getState().reset();

    expect(reclaimed()).toHaveLength(10);
    expect(reclaimed()).toContain("att-1");
    expect(reclaimed()).toContain("att-10");
  });

  test("a retracted send is not queued at a reset", () => {
    // The assistant answered for it, so it reclaims that attachment itself
    // and a delete from here would race it.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(false, "att-1");

    useLiveVoiceStore.getState().reset();

    expect(reclaimed()).toEqual([]);
  });

  test("an already queued id is not queued twice by a reset", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(true);
    expect(reclaimed()).toEqual(["att-1"]);

    useLiveVoiceStore.getState().reset();

    expect(reclaimed()).toEqual(["att-1"]);
  });

  test("a reset with no session assistant queues nothing", () => {
    // Nothing to aim a delete at, and an id with no assistant is not
    // actionable.
    useLiveVoiceStore.getState().noteSightFrameSent("att-1");

    useLiveVoiceStore.getState().reset();

    expect(reclaimed()).toEqual([]);
  });

  test("a reconnect clears the latch, so an upgraded assistant is tried again", () => {
    const { controls, generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    // What the controller does when it re-enters its connect flow: the
    // generation holds, the session state does not.
    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    useLiveVoiceStore.getState().setControls(controls);

    expect(useLiveVoiceStore.getState().sightFramesUnsupported).toBe(false);
    expect(sendLiveVoiceSightFrame("att-2", generation)).toBe(true);
  });

  test("taking returns exactly what it removes", () => {
    // The only way to empty the queue, so that nothing can leave it without
    // reaching a deleter.
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    const taken = useLiveVoiceStore
      .getState()
      .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER);

    expect(taken).toEqual([
      { assistantId: "asst_sight", attachmentId: "att-1" },
    ]);
    expect(reclaimed()).toEqual([]);
  });

  test("a reclaim queued after a take is still there for the next one", () => {
    const { generation } = sightSession();
    sendLiveVoiceSightFrame("att-1", generation);
    useLiveVoiceStore.getState().noteSightFrameRefused(true);
    useLiveVoiceStore
      .getState()
      .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER);

    useLiveVoiceStore.getState().noteSightFrameSent("att-2");
    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    expect(
      useLiveVoiceStore
        .getState()
        .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER),
    ).toEqual([{ assistantId: "asst_sight", attachmentId: "att-2" }]);
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

describe("useLiveVoiceStore — screen share", () => {
  afterEach(() => {
    useLiveVoiceStore.getState().reset();
  });

  test("drops a target with no session to show it to", () => {
    setLiveVoiceScreenShare({ kind: "display", displayId: 1 });
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
  });

  test("holds the target for a running session, and clears it on the stop", () => {
    useLiveVoiceStore.getState().setState("listening");
    setLiveVoiceScreenShare({ kind: "window", windowId: 7 });
    expect(useLiveVoiceStore.getState().screenShareTarget).toEqual({
      kind: "window",
      windowId: 7,
    });
    setLiveVoiceScreenShare(null);
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
  });

  test("survives a reconnect and not a new session", () => {
    useLiveVoiceStore.getState().setState("listening");
    setLiveVoiceScreenShare({ kind: "window", windowId: 7 });
    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    expect(useLiveVoiceStore.getState().screenShareTarget).toEqual({
      kind: "window",
      windowId: 7,
    });
    useLiveVoiceStore.getState().reset();
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
  });
});

describe("isLiveVoiceUserSpeaking", () => {
  test("is the VAD's utterance in hands-free", () => {
    expect(
      isLiveVoiceUserSpeaking({
        state: "listening",
        handsFree: true,
        utteranceOpen: false,
      }),
    ).toBe(false);
    expect(
      isLiveVoiceUserSpeaking({
        state: "thinking",
        handsFree: true,
        utteranceOpen: true,
      }),
    ).toBe(true);
  });

  test("is the session listening in push-to-talk, which has no VAD", () => {
    expect(
      isLiveVoiceUserSpeaking({
        state: "listening",
        handsFree: false,
        utteranceOpen: false,
      }),
    ).toBe(true);
    expect(
      isLiveVoiceUserSpeaking({
        state: "thinking",
        handsFree: false,
        utteranceOpen: true,
      }),
    ).toBe(false);
  });
});

describe("useLiveVoiceStore — a refused sight frame ends the share", () => {
  afterEach(() => {
    useLiveVoiceStore.getState().reset();
  });

  test("clears the target with the latch, so a reconnect cannot resume it", () => {
    useLiveVoiceStore.getState().setState("listening");
    setLiveVoiceScreenShare({ kind: "window", windowId: 7 });
    useLiveVoiceStore.getState().noteSightFrameRefused(true);
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
  });

  /**
   * The picker is not closed by the refusal, so its rows stay pressable. A
   * pick taken then would sit unshown until a reconnect cleared the latch and
   * started capture off a gesture made before the assistant refused.
   */
  test("takes no new target once the assistant has refused the frame", () => {
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().noteSightFrameRefused(true);
    setLiveVoiceScreenShare({ kind: "window", windowId: 9 });
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
    useLiveVoiceStore.getState().reset({ sessionContinues: true });
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
  });
});
