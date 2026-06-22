import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { DictationOverlayMessage } from "@/runtime/is-electron";

const messages: DictationOverlayMessage[] = [];

mock.module("@/runtime/dictation-overlay", () => ({
  setDictationOverlayState: (state: DictationOverlayMessage) => {
    messages.push(state);
  },
  subscribeToDictationOverlayState: () => () => undefined,
}));

const { useDictationOverlaySync } = await import("./use-dictation-overlay-sync");
const { useVoiceRecordingStore } = await import(
  "@/domains/chat/voice/voice-recording-store"
);
const { formatVoiceError } = await import("@/domains/chat/utils/chat");

const renderSync = () => {
  const hook = renderHook(() => useDictationOverlaySync());
  // Mounting in the store's idle phase publishes an initial dismiss —
  // uninteresting to every assertion below.
  messages.length = 0;
  return hook;
};

const store = () => useVoiceRecordingStore.getState();

afterEach(() => {
  cleanup();
  // Clears the store's done/error auto-dismiss timers so they can't fire
  // into a later test.
  act(() => {
    store().reset();
  });
  messages.length = 0;
});

describe("useDictationOverlaySync", () => {
  test("publishes recording states with the live interim transcript", () => {
    renderSync();

    act(() => {
      store().startRecording();
    });
    expect(messages).toEqual([
      { kind: "recording", transcription: "", audioLevel: 0 },
    ]);

    act(() => {
      store().setAudioLevel(0.42);
      store().setInterimTranscript("hello wor");
    });
    expect(messages[messages.length - 1]).toEqual({
      kind: "recording",
      transcription: "hello wor",
      audioLevel: 0.42,
    });
  });

  test("publishes processing, done, and dismiss through a successful session", () => {
    renderSync();

    act(() => {
      store().startRecording();
      store().stopRecording();
    });
    expect(messages[messages.length - 1]).toEqual({ kind: "processing" });

    act(() => {
      store().finalize();
    });
    expect(messages[messages.length - 1]).toEqual({ kind: "done" });

    act(() => {
      store().reset();
    });
    expect(messages[messages.length - 1]).toEqual({ kind: "dismiss" });
  });

  test("publishes a formatted error for STT failures", () => {
    renderSync();

    act(() => {
      store().startRecording();
      store().fail("stt-timeout");
    });

    expect(messages[messages.length - 1]).toEqual({
      kind: "error",
      message: formatVoiceError("stt-timeout"),
    });
  });

  test("unmounting mid-recording publishes a dismiss so the overlay can't stick", () => {
    const hook = renderSync();

    act(() => {
      store().startRecording();
    });
    messages.length = 0;

    hook.unmount();

    expect(messages).toContainEqual({ kind: "dismiss" });
  });

  test("a front-app insertion error turns the finalized session into an error, not done", () => {
    renderSync();

    act(() => {
      store().startRecording();
      store().stopRecording();
    });
    // Insertion failed: the transcript handler flags the error code, the
    // text falls back to the composer, and the recorder still finalizes.
    act(() => {
      store().flagDictationInsertionError("dictation-automation-denied");
      store().finalize();
    });

    expect(messages[messages.length - 1]).toEqual({
      kind: "error",
      message: formatVoiceError("dictation-automation-denied"),
    });
    expect(messages).not.toContainEqual({ kind: "done" });
  });

  test("a new session clears the previous session's interim and insertion error", () => {
    renderSync();

    act(() => {
      store().startRecording();
      store().setInterimTranscript("old words");
      store().flagDictationInsertionError("dictation-paste-blocked");
      store().stopRecording();
      store().finalize();
    });
    messages.length = 0;

    act(() => {
      store().startRecording();
    });
    expect(messages[0]).toEqual({
      kind: "recording",
      transcription: "",
      audioLevel: 0,
    });

    act(() => {
      store().stopRecording();
      store().finalize();
    });
    expect(messages[messages.length - 1]).toEqual({ kind: "done" });
  });
});
