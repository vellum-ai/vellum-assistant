/**
 * What the two chords on the voice key do: which press starts a share, which
 * one stops it, and what happens when there is no call to share with yet.
 *
 * The host is replaced, since the presses leave this renderer immediately and
 * what is under test is which of them leave and in what order. The store is
 * real: the toggle's whole question is whether a share is already running.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CompanionCapturePick } from "@vellumai/ipc-contract";

const setCompanionScreenShare = mock((_pick?: CompanionCapturePick) => {});
const toggleCompanionAnnotating = mock(() => {});
mock.module("@/runtime/companion-surface", () => ({
  setCompanionScreenShare,
  toggleCompanionAnnotating,
}));

const startVoiceFromSurface = mock(
  (_navigate: unknown, _options: unknown) => {},
);
mock.module("@/domains/chat/voice/live-voice/start-voice-request", () => ({
  startVoiceFromSurface,
}));

const expectScreenShare = mock(() => {});
mock.module("@/domains/chat/voice/live-voice/pending-screen-share", () => ({
  expectScreenShare,
}));

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { handleVoiceKeyChord, VOICE_KEY_DRAW_CHORD, VOICE_KEY_SHARE_CHORD } =
  await import("@/domains/chat/voice/voice-key-chords");

const navigate = () => undefined;

const press = (key: string): void => {
  handleVoiceKeyChord(key, navigate);
};

describe("the voice key's chords", () => {
  beforeEach(() => {
    setCompanionScreenShare.mockClear();
    toggleCompanionAnnotating.mockClear();
    startVoiceFromSurface.mockClear();
    expectScreenShare.mockClear();
    useLiveVoiceStore.getState().setState("idle");
    useLiveVoiceStore.getState().setScreenShareTarget(null);
  });

  afterEach(() => {
    useLiveVoiceStore.getState().setState("idle");
    useLiveVoiceStore.getState().setScreenShareTarget(null);
  });

  /**
   * The pointer's display named as the question rather than answered here:
   * where the mouse is belongs to the host, at the moment the press lands.
   */
  test("shares the screen under the pointer on a running call", () => {
    useLiveVoiceStore.getState().setState("listening");

    press(VOICE_KEY_SHARE_CHORD);

    expect(setCompanionScreenShare).toHaveBeenCalledWith({
      kind: "pointerDisplay",
    });
    expect(startVoiceFromSurface).not.toHaveBeenCalled();
    expect(expectScreenShare).not.toHaveBeenCalled();
  });

  /**
   * One press for both directions. The user is in another application, and
   * the control that would undo this is on a surface they are not looking at.
   */
  test("a second press stops the share", () => {
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore
      .getState()
      .setScreenShareTarget({ kind: "display", displayId: 1 });

    press(VOICE_KEY_SHARE_CHORD);

    expect(setCompanionScreenShare).toHaveBeenCalledTimes(1);
    expect(setCompanionScreenShare.mock.calls[0]).toEqual([]);
  });

  /**
   * The gesture means "show the assistant this", which with no call is two
   * errands. The share is armed before the pick is sent: main can resolve a
   * display without waiting for anything, so the target can come back before
   * the next line runs.
   */
  test("with no call, starts one and holds the screen for it", () => {
    press(VOICE_KEY_SHARE_CHORD);

    expect(expectScreenShare).toHaveBeenCalledTimes(1);
    expect(setCompanionScreenShare).toHaveBeenCalledWith({
      kind: "pointerDisplay",
    });
    expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);
    expect(startVoiceFromSurface.mock.calls[0]?.[1]).toEqual({
      entry: "voice_key",
    });
    expect(expectScreenShare.mock.invocationCallOrder[0]).toBeLessThan(
      setCompanionScreenShare.mock.invocationCallOrder[0] ?? 0,
    );
  });

  /** Main holds the mode, so main is the side that turns it over. */
  test("hands the pen to the host", () => {
    press(VOICE_KEY_DRAW_CHORD);

    expect(toggleCompanionAnnotating).toHaveBeenCalledTimes(1);
    expect(setCompanionScreenShare).not.toHaveBeenCalled();
  });

  /**
   * The host was asked to name two keys. A third arriving means the two sides
   * disagree about which, and the user's press is better left alone than
   * spent on a guess.
   */
  test("does nothing with a key that is neither", () => {
    press("q");

    expect(setCompanionScreenShare).not.toHaveBeenCalled();
    expect(toggleCompanionAnnotating).not.toHaveBeenCalled();
    expect(startVoiceFromSurface).not.toHaveBeenCalled();
  });
});
