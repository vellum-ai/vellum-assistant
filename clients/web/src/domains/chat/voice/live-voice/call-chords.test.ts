/**
 * What the chords a call answers do: which press starts a share, which stops
 * it, which mutes what, and what a press does when there is no call to act on.
 *
 * The host is replaced, since every press that leaves this renderer leaves it
 * immediately and what is under test is which of them leave. The store is real:
 * the toggles' whole question is what is already running or already muted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CompanionCapturePick } from "@vellumai/ipc-contract";

const setCompanionScreenShare = mock((_pick?: CompanionCapturePick) => {});
const toggleCompanionAnnotating = mock(() => {});
mock.module("@/runtime/companion-surface", () => ({
  setCompanionScreenShare,
  toggleCompanionAnnotating,
}));

let canBeShownTheScreen = true;
mock.module(
  "@/domains/chat/voice/live-voice/screen-share-availability",
  () => ({
    liveVoiceCanBeShownTheScreen: () => canBeShownTheScreen,
  }),
);

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const {
  CALL_DRAW_KEY,
  CALL_MUTE_ASSISTANT_KEY,
  CALL_MUTE_MIC_KEY,
  CALL_SHARE_KEY,
} = await import("@/domains/chat/voice/live-voice/call-chord-keys");
const { callChords, handleCallChord } =
  await import("@/domains/chat/voice/live-voice/call-chords");

/** The session's controls, which is where a mute lands. */
const setMuted = mock((_muted: boolean) => {});
const setOutputMuted = mock((_muted: boolean) => {});

const onACall = (): void => {
  useLiveVoiceStore.getState().setState("listening");
  useLiveVoiceStore.getState().setControls({
    stop: () => {},
    release: () => {},
    interrupt: () => {},
    setMuted,
    setOutputMuted,
    updateConfig: () => {},
  } as unknown as Parameters<
    ReturnType<typeof useLiveVoiceStore.getState>["setControls"]
  >[0]);
};

describe("the chords a call answers", () => {
  beforeEach(() => {
    setCompanionScreenShare.mockClear();
    toggleCompanionAnnotating.mockClear();
    setMuted.mockClear();
    setOutputMuted.mockClear();
    canBeShownTheScreen = true;
    useLiveVoiceStore.getState().reset();
  });

  afterEach(() => {
    useLiveVoiceStore.getState().reset();
    useLiveVoiceStore.getState().setControls(null);
  });

  /**
   * Option alone, and exactly Option: the host lets Option+Shift+S past, so
   * the shortcuts the user already has under those keep working.
   */
  test("asks for Option and all four keys on a call that can be shown the screen", () => {
    expect(callChords(true)).toEqual({
      kind: "chord",
      modifiers: ["option"],
      keys: ["s", "d", "m", "a"],
    });
  });

  /**
   * The share and the pen are controls the row does not offer on such a call,
   * and a key taken for a control that is not there is a key taken for nothing.
   */
  test("asks for only the mutes on a call that cannot be", () => {
    expect(callChords(false)).toEqual({
      kind: "chord",
      modifiers: ["option"],
      keys: ["m", "a"],
    });
  });

  /**
   * The pointer's display named as the question rather than answered here:
   * where the mouse is belongs to the host, at the moment the press lands.
   */
  test("shares the screen under the pointer", () => {
    onACall();

    handleCallChord(CALL_SHARE_KEY);

    expect(setCompanionScreenShare).toHaveBeenCalledWith({
      kind: "pointerDisplay",
    });
  });

  /**
   * One press for both directions. The user is in another application, and
   * the control that would undo this is on a surface they are not looking at.
   */
  test("a second press stops the share", () => {
    onACall();
    useLiveVoiceStore
      .getState()
      .setScreenShareTarget({ kind: "display", displayId: 1 });

    handleCallChord(CALL_SHARE_KEY);

    expect(setCompanionScreenShare).toHaveBeenCalledTimes(1);
    expect(setCompanionScreenShare.mock.calls[0]).toEqual([]);
  });

  /** Main holds the mode, so main is the side that turns it over. */
  test("hands the pen to the host", () => {
    onACall();

    handleCallChord(CALL_DRAW_KEY);

    expect(toggleCompanionAnnotating).toHaveBeenCalledTimes(1);
    expect(setCompanionScreenShare).not.toHaveBeenCalled();
  });

  /**
   * The binding drops these two keys when the answer turns negative, so a
   * press arriving after it is one made in the gap before the host heard. It
   * would start a share the row no longer offers.
   */
  test("refuses the share and the pen once the call cannot be shown the screen", () => {
    onACall();
    canBeShownTheScreen = false;

    handleCallChord(CALL_SHARE_KEY);
    handleCallChord(CALL_DRAW_KEY);

    expect(setCompanionScreenShare).not.toHaveBeenCalled();
    expect(toggleCompanionAnnotating).not.toHaveBeenCalled();
  });

  /**
   * One press for both directions, the way the share is: the mute control
   * that would undo it is on a surface the user is not looking at.
   */
  test("mutes the microphone, and unmutes it on the next press", () => {
    onACall();

    handleCallChord(CALL_MUTE_MIC_KEY);
    expect(setMuted).toHaveBeenLastCalledWith(true);

    useLiveVoiceStore.getState().setMuted(true);
    handleCallChord(CALL_MUTE_MIC_KEY);
    expect(setMuted).toHaveBeenLastCalledWith(false);

    expect(setOutputMuted).not.toHaveBeenCalled();
  });

  test("mutes the assistant's audio, and unmutes it on the next press", () => {
    onACall();

    handleCallChord(CALL_MUTE_ASSISTANT_KEY);
    expect(setOutputMuted).toHaveBeenLastCalledWith(true);

    useLiveVoiceStore.getState().setOutputMuted(true);
    handleCallChord(CALL_MUTE_ASSISTANT_KEY);
    expect(setOutputMuted).toHaveBeenLastCalledWith(false);

    expect(setMuted).not.toHaveBeenCalled();
  });

  /** The mutes are the call's, whatever the call can be shown. */
  test("mutes on a call that cannot be shown the screen", () => {
    onACall();
    canBeShownTheScreen = false;

    handleCallChord(CALL_MUTE_MIC_KEY);

    expect(setMuted).toHaveBeenCalledWith(true);
  });

  /**
   * The binding is armed only while a call is running, so a press arriving
   * with none is one made in the gap before the host heard the call end. It
   * belongs to whatever the user has moved on to.
   */
  test("does nothing with no call running", () => {
    handleCallChord(CALL_SHARE_KEY);
    handleCallChord(CALL_DRAW_KEY);
    handleCallChord(CALL_MUTE_MIC_KEY);
    handleCallChord(CALL_MUTE_ASSISTANT_KEY);

    expect(setCompanionScreenShare).not.toHaveBeenCalled();
    expect(toggleCompanionAnnotating).not.toHaveBeenCalled();
    expect(setMuted).not.toHaveBeenCalled();
    expect(setOutputMuted).not.toHaveBeenCalled();
  });

  /**
   * The host was asked for a fixed set of keys. Another arriving means the two
   * sides disagree about which, and the press is better left alone than spent
   * on a guess.
   */
  test("does nothing with a key that is none of them", () => {
    onACall();

    handleCallChord("q");

    expect(setCompanionScreenShare).not.toHaveBeenCalled();
    expect(toggleCompanionAnnotating).not.toHaveBeenCalled();
    expect(setMuted).not.toHaveBeenCalled();
    expect(setOutputMuted).not.toHaveBeenCalled();
  });
});
