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
  async (_blob: Blob, _assistantId: string, _signal?: AbortSignal) => ({
    status: "ok" as const,
    text: "hello world",
  }),
);
mock.module("@/domains/chat/voice/stt-api", () => ({
  postSttTranscribe: postSttTranscribeSpy,
}));

// No daemon stream and no native helper partials — live interim text is not
// under test, and returning null from both exercises the default web path.
mock.module("@/domains/chat/voice/dictation-stream", () => ({
  startDictationStream: () => null,
}));
mock.module("@/runtime/native-dictation-partials", () => ({
  startNativeDictationPartials: async () => null,
}));

mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));
mock.module("@/utils/voice-input-device", () => ({
  getVoiceInputMediaStream: async () => fakeStream,
  voiceInputAudioConstraints: () => true,
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
