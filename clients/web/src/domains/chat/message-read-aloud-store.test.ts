/**
 * Tests for message read-aloud playback: one message at a time, daemon TTS
 * when available, Web Speech fallback, and stop-on-toggle.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { waitFor } from "@testing-library/react";

type PlaybackResult =
  | { kind: "audio"; blob: Blob }
  | { kind: "unavailable" };

let playbackResult: PlaybackResult = { kind: "unavailable" };

const synthesizeMessagePlayback = mock(
  async (): Promise<PlaybackResult> => playbackResult,
);

mock.module("@/domains/chat/message-read-aloud-tts", () => ({
  synthesizeMessagePlayback,
}));

const toastError = mock(() => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: toastError, success: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { useMessageReadAloudStore } = await import(
  "@/domains/chat/message-read-aloud-store"
);

type Listener = (this: FakeAudio, ev?: Event) => void;

class FakeAudio {
  src = "";
  endedListeners: Listener[] = [];
  errorListeners: Listener[] = [];
  play = mock(async () => {});
  pause = mock(() => {});
  load = mock(() => {});
  removeAttribute = mock((name: string) => {
    if (name === "src") {
      this.src = "";
    }
  });
  addEventListener(type: string, listener: Listener): void {
    if (type === "ended") {
      this.endedListeners.push(listener);
    }
    if (type === "error") {
      this.errorListeners.push(listener);
    }
  }
}

const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalSpeechSynthesis = window.speechSynthesis;
const originalUtterance = globalThis.SpeechSynthesisUtterance;

const speak = mock((_utterance: { text: string }) => {});
const cancel = mock(() => {});
const resume = mock(() => {});

class FakeUtterance {
  volume = 1;
  onend: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((ev: SpeechSynthesisErrorEvent) => void) | null = null;
  constructor(public text: string) {}
}

function installSpeechSynthesis(): void {
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak, cancel, resume },
  });
  globalThis.SpeechSynthesisUtterance =
    FakeUtterance as unknown as typeof SpeechSynthesisUtterance;
}

function removeSpeechSynthesis(): void {
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: undefined,
  });
}

beforeEach(() => {
  playbackResult = { kind: "unavailable" };
  synthesizeMessagePlayback.mockClear();
  toastError.mockClear();
  speak.mockClear();
  cancel.mockClear();
  resume.mockClear();
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
  URL.createObjectURL = mock(() => "blob:read-aloud") as typeof URL.createObjectURL;
  URL.revokeObjectURL = mock(() => {}) as typeof URL.revokeObjectURL;
  installSpeechSynthesis();
  useMessageReadAloudStore.getState().stop();
});

afterEach(() => {
  useMessageReadAloudStore.getState().stop();
  globalThis.Audio = originalAudio;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: originalSpeechSynthesis,
  });
  globalThis.SpeechSynthesisUtterance = originalUtterance;
});

describe("message read-aloud store", () => {
  test("plays daemon audio and marks the message playing", async () => {
    playbackResult = {
      kind: "audio",
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
    };

    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-1",
      text: "hello there",
      assistantId: "asst-1",
      conversationId: "conv-xyz",
    });

    expect(useMessageReadAloudStore.getState().status).toBe("loading");
    expect(useMessageReadAloudStore.getState().messageId).toBe("msg-1");

    await waitFor(() => {
      expect(useMessageReadAloudStore.getState().status).toBe("playing");
    });
    expect(synthesizeMessagePlayback).toHaveBeenCalledTimes(1);
    const spokenMessage = speak.mock.calls.find(
      (call) => call[0].text === "hello there",
    );
    expect(spokenMessage).toBeUndefined();
  });

  test("falls back to web speech when daemon TTS is unavailable", async () => {
    playbackResult = { kind: "unavailable" };

    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-2",
      text: "hello there",
      assistantId: "asst-1",
    });

    await waitFor(() => {
      expect(useMessageReadAloudStore.getState().status).toBe("playing");
    });
    expect(speak.mock.calls.length).toBeGreaterThan(0);
    const spoken = speak.mock.calls.find(
      (call) => call[0].text === "hello there",
    );
    expect(spoken).toBeDefined();
  });

  test("uses web speech when there is no active assistant", async () => {
    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-3",
      text: "hello there",
      assistantId: null,
    });

    await waitFor(() => {
      expect(useMessageReadAloudStore.getState().status).toBe("playing");
    });
    expect(synthesizeMessagePlayback).not.toHaveBeenCalled();
  });

  test("toggling the playing message stops it", async () => {
    playbackResult = {
      kind: "audio",
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
    };

    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-4",
      text: "hello there",
      assistantId: "asst-1",
    });
    await waitFor(() => {
      expect(useMessageReadAloudStore.getState().status).toBe("playing");
    });

    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-4",
      text: "hello there",
      assistantId: "asst-1",
    });

    expect(useMessageReadAloudStore.getState().status).toBe("idle");
    expect(useMessageReadAloudStore.getState().messageId).toBeNull();
  });

  test("starting another message replaces the current one", async () => {
    playbackResult = {
      kind: "audio",
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
    };

    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-a",
      text: "first",
      assistantId: "asst-1",
    });
    await waitFor(() => {
      expect(useMessageReadAloudStore.getState().messageId).toBe("msg-a");
      expect(useMessageReadAloudStore.getState().status).toBe("playing");
    });

    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-b",
      text: "second",
      assistantId: "asst-1",
    });

    expect(useMessageReadAloudStore.getState().messageId).toBe("msg-b");
    expect(useMessageReadAloudStore.getState().status).toBe("loading");
    await waitFor(() => {
      expect(useMessageReadAloudStore.getState().status).toBe("playing");
    });
    expect(useMessageReadAloudStore.getState().messageId).toBe("msg-b");
  });

  test("toasts when neither daemon TTS nor web speech can play", async () => {
    removeSpeechSynthesis();
    playbackResult = { kind: "unavailable" };

    useMessageReadAloudStore.getState().toggle({
      messageId: "msg-5",
      text: "hello there",
      assistantId: "asst-1",
    });

    await waitFor(() => {
      expect(useMessageReadAloudStore.getState().status).toBe("idle");
    });
    expect(toastError).toHaveBeenCalled();
  });
});
