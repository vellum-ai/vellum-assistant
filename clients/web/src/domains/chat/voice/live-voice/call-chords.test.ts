/**
 * What the two chords a call answers do: which press starts a share, which
 * stops it, and what a press does when there is no call to act on.
 *
 * The host is replaced, since every press leaves this renderer immediately and
 * what is under test is which of them leave. The store is real: the toggle's
 * whole question is whether a share is already running.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CompanionCapturePick } from "@vellumai/ipc-contract";

const setCompanionScreenShare = mock((_pick?: CompanionCapturePick) => {});
const toggleCompanionAnnotating = mock(() => {});
mock.module("@/runtime/companion-surface", () => ({
  setCompanionScreenShare,
  toggleCompanionAnnotating,
}));

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { CALL_CHORDS, CALL_DRAW_KEY, CALL_SHARE_KEY, handleCallChord } =
  await import("@/domains/chat/voice/live-voice/call-chords");

const onACall = (): void => {
  useLiveVoiceStore.getState().setState("listening");
};

describe("the chords a call answers", () => {
  beforeEach(() => {
    setCompanionScreenShare.mockClear();
    toggleCompanionAnnotating.mockClear();
    useLiveVoiceStore.getState().setState("idle");
    useLiveVoiceStore.getState().setScreenShareTarget(null);
  });

  afterEach(() => {
    useLiveVoiceStore.getState().setState("idle");
    useLiveVoiceStore.getState().setScreenShareTarget(null);
  });

  /**
   * Option alone, and exactly Option: the host lets Option+Shift+S past, so
   * the shortcuts the user already has under those keep working.
   */
  test("asks for Option and the two keys", () => {
    expect(CALL_CHORDS).toEqual({
      kind: "chord",
      modifiers: ["option"],
      keys: ["s", "d"],
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
   * The binding is armed only while a call is running, so a press arriving
   * with none is one made in the gap before the host heard the call end. It
   * belongs to whatever the user has moved on to.
   */
  test("does nothing with no call running", () => {
    handleCallChord(CALL_SHARE_KEY);
    handleCallChord(CALL_DRAW_KEY);

    expect(setCompanionScreenShare).not.toHaveBeenCalled();
    expect(toggleCompanionAnnotating).not.toHaveBeenCalled();
  });

  /**
   * The host was asked for two keys. A third arriving means the two sides
   * disagree about which, and the press is better left alone than spent on a
   * guess.
   */
  test("does nothing with a key that is neither", () => {
    onACall();

    handleCallChord("q");

    expect(setCompanionScreenShare).not.toHaveBeenCalled();
    expect(toggleCompanionAnnotating).not.toHaveBeenCalled();
  });
});
