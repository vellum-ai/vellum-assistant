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

type SyncProps = { interim: string; errorCode: string | null };

const renderSync = (
  initialProps: SyncProps = { interim: "", errorCode: null },
) => {
  const hook = renderHook((props: SyncProps) => useDictationOverlaySync(props), {
    initialProps,
  });
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
    const hook = renderSync();

    act(() => {
      store().startRecording();
    });
    expect(messages).toEqual([{ kind: "recording", transcription: "" }]);

    hook.rerender({ interim: "hello wor", errorCode: null });
    expect(messages[messages.length - 1]).toEqual({
      kind: "recording",
      transcription: "hello wor",
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
    const hook = renderSync();

    act(() => {
      store().startRecording();
      store().stopRecording();
    });
    // Insertion failed: `handleVoiceTranscript` sets the voice error code,
    // falls back to the composer, and the recorder still finalizes.
    hook.rerender({ interim: "", errorCode: "dictation-automation-denied" });
    act(() => {
      store().finalize();
    });

    expect(messages[messages.length - 1]).toEqual({
      kind: "error",
      message: formatVoiceError("dictation-automation-denied"),
    });
    expect(messages).not.toContainEqual({ kind: "done" });
  });
});
