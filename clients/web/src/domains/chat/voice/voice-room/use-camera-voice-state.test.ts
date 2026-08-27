/**
 * The camera pill's dot reports the session's own signals, so every case here
 * is about the dot refusing to claim a voice the session does not have.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, cleanup, renderHook } from "@testing-library/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useCameraVoiceState } from "@/domains/chat/voice/voice-room/use-camera-voice-state";

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

/** The room's call: phase, whether assistant audio is flowing, camera open. */
function render(
  state: Parameters<typeof useCameraVoiceState>[0],
  assistantAudioActive: boolean,
  enabled: boolean,
) {
  return renderHook(() =>
    useCameraVoiceState(state, assistantAudioActive, enabled),
  );
}

describe("useCameraVoiceState", () => {
  test("is idle while listening to a room nobody is speaking into", () => {
    // The point of reading the VAD rather than the microphone: a fan, a car,
    // a television are all amplitude, and none of them is the user's turn.
    useLiveVoiceStore.getState().setInputAmplitude(0.9);
    const { result } = render("listening", false, true);

    expect(result.current).toBe("idle");
  });

  test("reports the user exactly while the server VAD holds an utterance", () => {
    const { result } = render("listening", false, true);
    expect(result.current).toBe("idle");

    act(() => {
      useLiveVoiceStore.getState().setUtteranceOpen(true);
    });
    expect(result.current).toBe("user");

    act(() => {
      useLiveVoiceStore.getState().setUtteranceOpen(false);
    });
    expect(result.current).toBe("idle");
  });

  test("says nothing about the user while the camera is closed", () => {
    useLiveVoiceStore.getState().setUtteranceOpen(true);
    const { result } = render("listening", false, false);

    expect(result.current).toBe("idle");
  });

  test("says nothing about the user while the mic is muted", () => {
    // Muting streams silence rather than closing the socket, so an utterance
    // caught mid-word stays open until the VAD's silence window expires. The
    // pill's own word reads "Muted" for that whole window.
    useLiveVoiceStore.getState().setUtteranceOpen(true);
    useLiveVoiceStore.getState().setMuted(true);
    const { result } = render("listening", false, true);

    expect(result.current).toBe("idle");
  });

  test("reports the assistant only while its audio is actually flowing", () => {
    // `speaking` stays set across a mid-turn tool run, which is silence.
    expect(render("speaking", false, true).result.current).toBe("idle");
    cleanup();
    expect(render("speaking", true, true).result.current).toBe("assistant");
  });

  test("gives the assistant the dot when both have a claim on it", () => {
    useLiveVoiceStore.getState().setUtteranceOpen(true);
    const { result } = render("speaking", true, true);

    expect(result.current).toBe("assistant");
  });

  test("is idle in every phase with no voice in it", () => {
    useLiveVoiceStore.getState().setUtteranceOpen(true);
    for (const state of ["connecting", "transcribing", "thinking"] as const) {
      const { result } = render(state, true, true);
      expect(result.current).toBe("idle");
      cleanup();
    }
  });
});
