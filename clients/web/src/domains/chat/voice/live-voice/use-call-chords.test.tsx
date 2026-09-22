/**
 * When the call's chords are armed and when they are not, which is the whole
 * of what this hook owns.
 *
 * It matters more than a binding usually would: while the binding is armed the
 * host *takes* these presses, so a binding left up outside a call is Option+S
 * silently doing nothing in the user's own applications.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type {
  ChordBinding,
  CompanionIntroCallControl,
  HotkeyEvent,
} from "@vellumai/ipc-contract";

let chordsSupported = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;
const setChordBinding = mock(async (_binding: ChordBinding) => ({
  ok: true as const,
  enabled: true,
}));
mock.module("@/runtime/hotkey", () => ({
  supportsChords: () => chordsSupported,
  setChordBinding,
  subscribeToHotkeyEvents: (callback: (event: HotkeyEvent) => void) => {
    emitHotkeyEvent = callback;
    return () => {
      emitHotkeyEvent = null;
    };
  },
}));

const handleCallChord = mock((_key: string) => {});
/**
 * Stand-ins for the two bindings the real builder returns, one per answer it
 * is asked. Sentinels rather than a copy of the builder: what this hook owns is
 * which answer it asks with and when, and the keys are the builder's own test.
 */
const ALL_CHORDS: ChordBinding = {
  kind: "chord",
  modifiers: ["option"],
  keys: ["all"],
};
const MUTE_CHORDS: ChordBinding = {
  kind: "chord",
  modifiers: ["option"],
  keys: ["mutes"],
};
const callChords = mock(
  (canBeShownTheScreen: boolean): ChordBinding =>
    canBeShownTheScreen ? ALL_CHORDS : MUTE_CHORDS,
);
mock.module("@/domains/chat/voice/live-voice/call-chords", () => ({
  handleCallChord,
  callChords,
}));

/**
 * Which control the companion's introduction is asking for a chord for, as
 * main reports it. Driven directly rather than through a fake bridge: what
 * this hook owns is what it arms for each answer, and the answer arriving is
 * `companion-intro-chord`'s own business.
 */
let introControl: CompanionIntroCallControl | null = null;
mock.module("@/runtime/companion-intro-chord", () => ({
  useCompanionIntroChord: () => introControl,
}));

let canBeShownTheScreen = false;
mock.module(
  "@/domains/chat/voice/live-voice/screen-share-availability",
  () => ({
    liveVoiceCanBeShownTheScreen: () => canBeShownTheScreen,
  }),
);

const { useCallChords } =
  await import("@/domains/chat/voice/live-voice/use-call-chords");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
// The real store and the real key table, since what a press amounts to is half
// of what the introduction's half of this hook does.
const { useIntroCallChordStore } =
  await import("@/domains/chat/voice/intro-call-chord-store");
const { INTRO_CALL_CHORD_KEYS } =
  await import("@/domains/chat/voice/live-voice/intro-call-chords");

/** Move the session, which is what the hook is subscribed through. */
const setCall = (running: boolean): void => {
  act(() => {
    canBeShownTheScreen = running;
    useLiveVoiceStore.getState().setState(running ? "listening" : "idle");
  });
};

const armedWith = (): ChordBinding | undefined =>
  setChordBinding.mock.calls.at(-1)?.[0];

describe("the call's chords", () => {
  beforeEach(() => {
    chordsSupported = true;
    canBeShownTheScreen = false;
    introControl = null;
    setChordBinding.mockClear();
    handleCallChord.mockClear();
    callChords.mockClear();
    useLiveVoiceStore.getState().setState("idle");
  });

  afterEach(() => {
    cleanup();
    emitHotkeyEvent = null;
    useLiveVoiceStore.getState().setState("idle");
  });

  test("arms nothing until there is a call", () => {
    renderHook(() => useCallChords());

    expect(setChordBinding).not.toHaveBeenCalled();
  });

  test("arms them for a call that starts", () => {
    renderHook(() => useCallChords());

    setCall(true);

    expect(callChords).toHaveBeenLastCalledWith(true);
    expect(armedWith()).toBe(ALL_CHORDS);
  });

  /**
   * The mutes are the call's whatever it can be shown. The share and the pen
   * are armed on the same answer the pill offers Share on, and follow it.
   */
  test("arms only the mutes for a call that cannot be shown the screen", () => {
    renderHook(() => useCallChords());

    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    expect(callChords).toHaveBeenLastCalledWith(false);
    expect(armedWith()).toBe(MUTE_CHORDS);
  });

  test("adds the share and the pen when the call can be shown the screen", () => {
    renderHook(() => useCallChords());
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    act(() => {
      canBeShownTheScreen = true;
      // The answer is read through the store, so a change to it reaches the
      // hook with the next store update, the way the real conjunction's terms do.
      useLiveVoiceStore.getState().setState("speaking");
    });

    expect(callChords).toHaveBeenLastCalledWith(true);
    expect(armedWith()).toBe(ALL_CHORDS);
  });

  /**
   * The keys go back to the user the moment the call does. A binding left up
   * is the host swallowing Option+S in their editor.
   */
  test("clears them when the call ends", () => {
    renderHook(() => useCallChords());
    setCall(true);
    setChordBinding.mockClear();

    setCall(false);

    expect(armedWith()).toEqual({ kind: "off" });
  });

  test("clears them when the window goes away mid-call", () => {
    const view = renderHook(() => useCallChords());
    setCall(true);
    setChordBinding.mockClear();

    act(() => {
      view.unmount();
    });

    expect(armedWith()).toEqual({ kind: "off" });
  });

  test("hands a chord to the action it names", () => {
    renderHook(() => useCallChords());
    setCall(true);

    act(() => {
      emitHotkeyEvent?.({ kind: "chord", state: "down", key: "s" });
    });

    expect(handleCallChord).toHaveBeenCalledWith("s");
  });

  /** The hold's edges are the voice key's business, not this binding's. */
  test("ignores the other bindings' events", () => {
    renderHook(() => useCallChords());
    setCall(true);

    act(() => {
      emitHotkeyEvent?.({ kind: "modifierHold", state: "down" });
      emitHotkeyEvent?.({ kind: "voiceModeChord", state: "down" });
    });

    expect(handleCallChord).not.toHaveBeenCalled();
  });

  test("arms nothing on a host that cannot watch a chord", () => {
    chordsSupported = false;
    renderHook(() => useCallChords());

    setCall(true);

    expect(setChordBinding).not.toHaveBeenCalled();
  });
});

/**
 * The chord the companion's introduction asks for, which the same effect arms
 * because the host holds one binding per window.
 *
 * Three beats of the run draw a call control beside its shortcut, and the chip
 * lights when the real keys are pressed. Nothing else happens: the pill those
 * beats draw is a picture of a call with no session behind it, so there is
 * nothing for the press to do, and while the binding is up the host takes
 * Option+M from whatever the user is actually working in.
 */
describe("the introduction's chord", () => {
  /** Move the beat, which reaches the hook as a re-render the way main's push does. */
  const setIntro = (
    view: { rerender: () => void },
    control: CompanionIntroCallControl | null,
  ): void => {
    act(() => {
      introControl = control;
      view.rerender();
    });
  };

  beforeEach(() => {
    chordsSupported = true;
    canBeShownTheScreen = false;
    introControl = null;
    setChordBinding.mockClear();
    handleCallChord.mockClear();
    useLiveVoiceStore.getState().setState("idle");
    useIntroCallChordStore.setState({ presses: 0, control: null });
  });

  afterEach(() => {
    cleanup();
    emitHotkeyEvent = null;
    introControl = null;
    useLiveVoiceStore.getState().setState("idle");
  });

  /**
   * Five of the eight beats ask for nothing, and so does the whole of the rest
   * of the install. A binding armed there is a key taken for a card nobody is
   * looking at.
   */
  test("arms nothing on the beats that ask for none", () => {
    renderHook(() => useCallChords());

    expect(setChordBinding).not.toHaveBeenCalled();
  });

  /**
   * One key, not the call's four. A beat offers one control, and the other
   * three chords would be taken from the desktop for a card that never
   * mentions them.
   */
  test("arms the one key the beat is asking for", () => {
    const view = renderHook(() => useCallChords());

    setIntro(view, "mute");

    expect(armedWith()).toEqual({
      kind: "chord",
      modifiers: ["option"],
      keys: [INTRO_CALL_CHORD_KEYS.mute],
    });
  });

  test("counts a press against the control the beat named", () => {
    const view = renderHook(() => useCallChords());
    setIntro(view, "draw");

    act(() => {
      emitHotkeyEvent?.({
        kind: "chord",
        state: "down",
        key: INTRO_CALL_CHORD_KEYS.draw,
      });
    });

    expect(useIntroCallChordStore.getState()).toMatchObject({
      presses: 1,
      control: "draw",
    });
  });

  /** The beat's pill is a drawing of a call, so there is nothing to act on. */
  test("performs nothing the press would do on a real call", () => {
    const view = renderHook(() => useCallChords());
    setIntro(view, "share");

    act(() => {
      emitHotkeyEvent?.({
        kind: "chord",
        state: "down",
        key: INTRO_CALL_CHORD_KEYS.share,
      });
    });

    expect(handleCallChord).not.toHaveBeenCalled();
  });

  /** Only one key was armed, so another arriving is the two sides disagreeing. */
  test("ignores a key it did not arm", () => {
    const view = renderHook(() => useCallChords());
    setIntro(view, "mute");

    act(() => {
      emitHotkeyEvent?.({
        kind: "chord",
        state: "down",
        key: INTRO_CALL_CHORD_KEYS.share,
      });
    });

    expect(useIntroCallChordStore.getState().presses).toBe(0);
  });

  test("gives the key back when the run walks on", () => {
    const view = renderHook(() => useCallChords());
    setIntro(view, "mute");
    setChordBinding.mockClear();

    setIntro(view, null);

    expect(armedWith()).toEqual({ kind: "off" });
  });

  /**
   * The run ends by starting a real call, so the beat going away and the
   * session arriving are the same moment from two directions. Whichever lands
   * first, what the user is left with is the call's own binding: a release that
   * outlived it would be Option+M doing nothing mid-conversation.
   */
  test("leaves the call's binding standing when the run ends into a call", () => {
    const view = renderHook(() => useCallChords());
    setIntro(view, "mute");

    setCall(true);
    setIntro(view, null);

    expect(armedWith()).toBe(ALL_CHORDS);

    act(() => {
      emitHotkeyEvent?.({ kind: "chord", state: "down", key: "s" });
    });
    expect(handleCallChord).toHaveBeenCalledWith("s");
  });

  /**
   * The other order: a call that starts while a beat still has a key armed.
   * The call is the only one of the two whose chords do anything, so it takes
   * the binding and the press with it.
   */
  test("hands the binding to a call that starts mid-beat", () => {
    const view = renderHook(() => useCallChords());
    setIntro(view, "mute");

    setCall(true);

    expect(armedWith()).toBe(ALL_CHORDS);

    act(() => {
      emitHotkeyEvent?.({
        kind: "chord",
        state: "down",
        key: INTRO_CALL_CHORD_KEYS.mute,
      });
    });
    expect(handleCallChord).toHaveBeenCalledWith(INTRO_CALL_CHORD_KEYS.mute);
    expect(useIntroCallChordStore.getState().presses).toBe(0);
  });

  test("arms nothing on a host that cannot watch a chord", () => {
    chordsSupported = false;
    const view = renderHook(() => useCallChords());

    setIntro(view, "share");

    expect(setChordBinding).not.toHaveBeenCalled();
  });
});
