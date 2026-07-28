/**
 * Tests for `VoiceInputButton`'s session-termination behavior:
 *
 *   1. Esc during recording discards the session — the captured audio is
 *      never transcribed and no transcript is delivered.
 *   2. Each session emits exactly one Sentry breadcrumb with duration,
 *      locale, and final transcript length (metrics only — never the
 *      transcript text).
 *
 * The browser capture surface (`MediaRecorder` + `getUserMedia`) is faked at
 * the global level since happy-dom provides neither; the fake recorder fires
 * `ondataavailable` + `onstop` synchronously from `stop()` so the discard /
 * transcribe branching is observable without timer games.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const addBreadcrumbSpy = mock((_breadcrumb: unknown) => {});
mock.module("@sentry/react", () => ({
  addBreadcrumb: addBreadcrumbSpy,
}));

const postSttTranscribeSpy = mock(
  async (
    _blob: Blob,
    _assistantId: string,
    _signal?: AbortSignal,
  ): Promise<
    { status: "ok"; text: string } | { status: "error"; reason: string }
  > => ({
    status: "ok",
    text: "hello world",
  }),
);
// Flipped on by the forced-native tests — mirrors the user picking
// "macOS Native Dictation" as the STT provider in Settings.
let prefersNativeStt = false;
mock.module("@/domains/chat/voice/stt-api", () => ({
  postSttTranscribe: postSttTranscribeSpy,
  prefersMacosNativeStt: () => prefersNativeStt,
}));

// The daemon stream defaults to unavailable (null) — live interim text from
// that source is not under test; the fallback tests swap in a fake handle to
// drive the stream-death path.
interface FakeDictationStreamArgs {
  onPartial: (text: string) => void;
}
let dictationStreamImpl: (
  args: FakeDictationStreamArgs,
) => { isLive: () => boolean; stop: () => void } | null = () => null;
mock.module("@/domains/chat/voice/dictation-stream", () => ({
  startDictationStream: (args: FakeDictationStreamArgs) =>
    dictationStreamImpl(args),
}));

// Native helper partials default to unavailable (the plain web path); the
// fallback tests swap in an implementation that emits text.
let nativePartialsImpl: (
  onPartial: (text: string) => void,
) => Promise<(() => void | Promise<string | null>) | null> = async () => null;
let transcribeBlobImpl: () => Promise<string | null> = async () => null;
mock.module("@/runtime/native-dictation-partials", () => ({
  startNativeDictationPartials: (onPartial: (text: string) => void) =>
    nativePartialsImpl(onPartial),
  transcribeNativeAudioBlob: () => transcribeBlobImpl(),
}));

mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));
mock.module("@/utils/voice-input-device", () => ({
  getVoiceInputMediaStream: async () => fakeStream,
  voiceInputAudioConstraints: () => ({}),
}));

// Capture the command handler map the component registers so tests can
// deliver the escape monitor's `cancelDictation` relay directly (the real
// hook is an Electron IPC subscription and no-ops in this environment).
const commandHandlers: Record<string, ((command: unknown) => void) | undefined> =
  {};
mock.module("@/runtime/vellum-commands", () => ({
  useVellumCommands: (
    handlers: Record<string, (command: unknown) => void>,
  ) => {
    Object.assign(commandHandlers, handlers);
  },
}));

// ---------------------------------------------------------------------------
// Browser capture fakes
// ---------------------------------------------------------------------------

class FakeMediaRecorder {
  static isTypeSupported = (_type: string) => true;
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    _stream: unknown,
    _options?: unknown,
  ) {}

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    });
    this.onstop?.();
  }
}

(globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;

const fakeStream = {
  getTracks: () => [{ stop: () => {} }],
} as unknown as MediaStream;
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => fakeStream,
  },
});

// Imported after the mocks so the component resolves against them. The
// recording store is intentionally real — phase transitions are part of the
// behavior under test.
const { VoiceInputButton } = await import(
  "@/domains/chat/components/voice-input-button"
);
const { useVoiceRecordingStore } = await import(
  "@/domains/chat/voice/voice-recording-store"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedBreadcrumb {
  category: string;
  data: {
    outcome: string;
    durationMs: number;
    locale: string;
    finalLength: number;
  };
}

function lastBreadcrumb(): RecordedBreadcrumb {
  const calls = addBreadcrumbSpy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as RecordedBreadcrumb;
}

async function startSession(onTranscript: (text: string) => Promise<void>) {
  render(
    <VoiceInputButton assistantId="assistant-1" onTranscript={onTranscript} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  // The stop affordance appearing proves the recording render committed and
  // the Escape listener effect has flushed.
  await screen.findByRole("button", { name: "Stop recording" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VoiceInputButton — Esc cancellation", () => {
  beforeEach(() => {
    addBreadcrumbSpy.mockClear();
    postSttTranscribeSpy.mockClear();
    useVoiceRecordingStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useVoiceRecordingStore.getState().reset();
  });

  test("Escape during recording discards the partial result", async () => {
    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().phase).toBe("idle");
    });
    expect(postSttTranscribeSpy).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();

    const crumb = lastBreadcrumb();
    expect(crumb.category).toBe("dictation");
    expect(crumb.data.outcome).toBe("cancelled");
    expect(crumb.data.finalLength).toBe(0);
  });

  test("cancelDictation command (escape monitor relay) discards like Escape", async () => {
    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    act(() => {
      commandHandlers.cancelDictation?.({ kind: "cancelDictation" });
    });

    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().phase).toBe("idle");
    });
    expect(postSttTranscribeSpy).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(lastBreadcrumb().data.outcome).toBe("cancelled");
  });

  test("Escape while idle does nothing", () => {
    const onTranscript = mock(async (_text: string) => {});
    render(
      <VoiceInputButton
        assistantId="assistant-1"
        onTranscript={onTranscript}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(useVoiceRecordingStore.getState().phase).toBe("idle");
    expect(addBreadcrumbSpy).not.toHaveBeenCalled();
  });
});

describe("VoiceInputButton — session breadcrumb", () => {
  beforeEach(() => {
    addBreadcrumbSpy.mockClear();
    postSttTranscribeSpy.mockClear();
    useVoiceRecordingStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useVoiceRecordingStore.getState().reset();
  });

  test("completed session emits one breadcrumb with duration, locale, and final length", async () => {
    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("hello world");
    });
    expect(postSttTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(addBreadcrumbSpy).toHaveBeenCalledTimes(1);

    const crumb = lastBreadcrumb();
    expect(crumb.category).toBe("dictation");
    expect(crumb.data.outcome).toBe("completed");
    expect(crumb.data.finalLength).toBe("hello world".length);
    expect(crumb.data.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof crumb.data.locale).toBe("string");
  });
});

describe("VoiceInputButton — native partials fallback", () => {
  beforeEach(() => {
    addBreadcrumbSpy.mockClear();
    postSttTranscribeSpy.mockClear();
    useVoiceRecordingStore.getState().reset();
  });

  afterEach(() => {
    nativePartialsImpl = async () => null;
    transcribeBlobImpl = async () => null;
    dictationStreamImpl = () => null;
    cleanup();
    useVoiceRecordingStore.getState().reset();
  });

  test("configuration errors still surface when no native final is available", async () => {
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "config-missing",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().phase).toBe("error");
    });
    expect(useVoiceRecordingStore.getState().errorCode).toBe(
      "stt-not-configured",
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(lastBreadcrumb().data.outcome).toBe("error");
  });

  test("native Apple Speech text becomes the final transcript when batch STT fails", async () => {
    nativePartialsImpl = async (onPartial) => {
      onPartial("offline transcript");
      return () => {};
    };
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "network",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("offline transcript");
    });
    expect(lastBreadcrumb().data.outcome).toBe("completed");
  });

  test("recognizer final transcript delivered after stop becomes the transcript", async () => {
    // A 1-2s dictation ends before the first partial: live text stays
    // empty, and the full utterance arrives only via the post-stop
    // finalized result.
    nativePartialsImpl = async () => {
      return () => Promise.resolve("the full final sentence");
    };
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "network",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("the full final sentence");
    });
    expect(lastBreadcrumb().data.outcome).toBe("completed");
  });

  test("empty native final makes an unconfigured daemon response an empty dictation", async () => {
    nativePartialsImpl = async () => {
      return () => Promise.resolve(null);
    };
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "config-missing",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().phase).toBe("idle");
    });
    expect(useVoiceRecordingStore.getState().errorCode).toBeNull();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(postSttTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(lastBreadcrumb().data.outcome).toBe("empty");
  });

  test("waits for empty native final when stop races native startup", async () => {
    let resolveNativeStart:
      | ((stop: (() => Promise<string | null>) | null) => void)
      | null = null;
    nativePartialsImpl = () =>
      new Promise<(() => Promise<string | null>) | null>((resolve) => {
        resolveNativeStart = resolve;
      });
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "config-missing",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);
    await waitFor(() => {
      expect(resolveNativeStart).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    act(() => {
      resolveNativeStart?.(() => Promise.resolve(null));
    });

    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().phase).toBe("idle");
    });
    expect(useVoiceRecordingStore.getState().errorCode).toBeNull();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(postSttTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(lastBreadcrumb().data.outcome).toBe("empty");
  });

  test("configuration errors still surface when native startup resolves unavailable after stop", async () => {
    let resolveNativeStart:
      | ((stop: (() => Promise<string | null>) | null) => void)
      | null = null;
    nativePartialsImpl = () =>
      new Promise<(() => Promise<string | null>) | null>((resolve) => {
        resolveNativeStart = resolve;
      });
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "config-missing",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);
    await waitFor(() => {
      expect(resolveNativeStart).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    act(() => {
      resolveNativeStart?.(null);
    });

    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().phase).toBe("error");
    });
    expect(useVoiceRecordingStore.getState().errorCode).toBe(
      "stt-not-configured",
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(postSttTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(lastBreadcrumb().data.outcome).toBe("error");
  });

  test("successful batch STT takes priority over native partials text", async () => {
    nativePartialsImpl = async (onPartial) => {
      onPartial("offline transcript");
      return () => {};
    };

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("hello world");
    });
  });

  test("whole-recording native transcribe wins when batch fails", async () => {
    // The blob transcript covers the complete utterance; streamed partials
    // can miss the leading words on short dictations.
    nativePartialsImpl = async (onPartial) => {
      onPartial("partial tail");
      return () => Promise.resolve("streamed final");
    };
    transcribeBlobImpl = async () => "the complete utterance";
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "network",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("the complete utterance");
    });
    expect(lastBreadcrumb().data.outcome).toBe("completed");
  });

  test("native recognizer runs alongside a silent stream and wins the fallback", async () => {
    let streamOnPartial: ((text: string) => void) | undefined;
    dictationStreamImpl = (args) => {
      streamOnPartial = args.onPartial;
      // A stream whose daemon is reachable (localhost) but whose provider
      // is not: the handle exists, never goes live, never errors.
      return { isLive: () => false, stop: () => {} };
    };
    nativePartialsImpl = async (onPartial) => {
      onPartial("offline transcript");
      return () => {};
    };
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "network",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    // The recognizer started eagerly — its text is already live even though
    // the stream handle exists.
    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().interimTranscript).toBe(
        "offline transcript",
      );
    });
    act(() => streamOnPartial?.("stream words"));

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    // Native text outranks the stream's partial transcript.
    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("offline transcript");
    });
  });

  test("stream text alone survives when the native helper is unavailable", async () => {
    let streamOnPartial: ((text: string) => void) | undefined;
    dictationStreamImpl = (args) => {
      streamOnPartial = args.onPartial;
      return { isLive: () => false, stop: () => {} };
    };
    postSttTranscribeSpy.mockImplementationOnce(async () => ({
      status: "error",
      reason: "network",
    }));

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    act(() => streamOnPartial?.("stream words"));

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("stream words");
    });
  });
});

describe("VoiceInputButton — forced native provider (macOS Native Dictation)", () => {
  beforeEach(() => {
    addBreadcrumbSpy.mockClear();
    postSttTranscribeSpy.mockClear();
    prefersNativeStt = true;
    useVoiceRecordingStore.getState().reset();
  });

  afterEach(() => {
    prefersNativeStt = false;
    nativePartialsImpl = async () => null;
    transcribeBlobImpl = async () => null;
    dictationStreamImpl = () => null;
    cleanup();
    useVoiceRecordingStore.getState().reset();
  });

  test("skips batch STT and the daemon stream; native transcript is the authority", async () => {
    let streamStarted = false;
    dictationStreamImpl = () => {
      streamStarted = true;
      return { isLive: () => true, stop: () => {} };
    };
    transcribeBlobImpl = async () => "spoken natively";

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("spoken natively");
    });
    expect(postSttTranscribeSpy).not.toHaveBeenCalled();
    expect(streamStarted).toBe(false);
    expect(lastBreadcrumb().data.outcome).toBe("completed");
  });

  test("captured audio with no native transcript surfaces the dictation-setup error", async () => {
    transcribeBlobImpl = async () => null;

    const onTranscript = mock(async (_text: string) => {});
    await startSession(onTranscript);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(useVoiceRecordingStore.getState().phase).toBe("error");
    });
    expect(useVoiceRecordingStore.getState().errorCode).toBe(
      "native-stt-no-transcript",
    );
    expect(postSttTranscribeSpy).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(lastBreadcrumb().data.outcome).toBe("error");
  });
});
