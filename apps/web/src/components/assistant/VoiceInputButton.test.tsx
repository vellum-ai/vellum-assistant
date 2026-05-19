/**
 * Tests for `VoiceInputButton`'s platform-support helpers.
 *
 * The web workspace does not run DOM-based tests, so the suite covers
 * the parts of the public contract that matter at module scope:
 *
 *   1. `isBatchSttSupported()` — the pure helper that reports whether
 *      MediaRecorder-based STT is usable in the current runtime.
 *   2. `getSpeechRecognitionCtor()` — the Web Speech API helper, feature-
 *      detected via the constructor itself per `web/AGENTS.md`.
 *   3. The component's SSR output — `renderToStaticMarkup` runs with
 *      the `useSyncExternalStore` server snapshot, which always reports
 *      `supported = false`. The only contract that survives SSR is
 *      "render nothing".
 */

import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { act, cleanup, render, waitFor } from "@/test-utils.js";

import {
  VoiceInputButton,
  errorCodeForReason,
  getSpeechRecognitionCtor,
  isBatchSttSupported,
} from "@/components/assistant/VoiceInputButton.js";

// ---------------------------------------------------------------------------
// Window lifecycle — each test starts with a clean slate so the SSR branch
// and the runtime branch can be exercised independently.
// ---------------------------------------------------------------------------

const originalWindow = (globalThis as { window?: unknown }).window;
const originalNavigator = (globalThis as { navigator?: unknown }).navigator;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  if (originalNavigator === undefined) {
    delete (globalThis as { navigator?: unknown }).navigator;
  } else {
    (globalThis as { navigator?: unknown }).navigator = originalNavigator;
  }
});

// ---------------------------------------------------------------------------
// isBatchSttSupported — pure helper.
// ---------------------------------------------------------------------------

describe("isBatchSttSupported", () => {
  test("returns false when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(isBatchSttSupported()).toBe(false);
  });

  test("returns false when MediaRecorder is unavailable", () => {
    (globalThis as { window?: unknown }).window = {};
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    (
      globalThis as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }
    ).navigator = { mediaDevices: { getUserMedia: () => {} } };

    expect(isBatchSttSupported()).toBe(false);
  });

  test("returns false when getUserMedia is unavailable", () => {
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {};
    (globalThis as { navigator?: unknown }).navigator = { mediaDevices: {} };

    expect(isBatchSttSupported()).toBe(false);
  });

  test("returns true when MediaRecorder, getUserMedia, and MIME type are all available", () => {
    (globalThis as { window?: unknown }).window = {};
    const FakeRecorder = class {} as unknown as typeof MediaRecorder;
    (FakeRecorder as { isTypeSupported: (t: string) => boolean }).isTypeSupported = () => true;
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
    (
      globalThis as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }
    ).navigator = { mediaDevices: { getUserMedia: () => {} } };

    expect(isBatchSttSupported()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSpeechRecognitionCtor — Web Speech API gate.
// ---------------------------------------------------------------------------

describe("getSpeechRecognitionCtor", () => {
  test("returns null when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(getSpeechRecognitionCtor()).toBeNull();
  });

  test("returns the constructor when window exposes webkitSpeechRecognition", () => {
    class FakeRecognizer {}
    (globalThis as { window?: unknown }).window = {
      webkitSpeechRecognition: FakeRecognizer,
    };

    expect(getSpeechRecognitionCtor()).toBe(
      FakeRecognizer as unknown as ReturnType<typeof getSpeechRecognitionCtor>,
    );
  });
});

// ---------------------------------------------------------------------------
// VoiceInputButton SSR snapshot — `useSyncExternalStore` always returns the
// server snapshot (`false`) during `renderToStaticMarkup`, so the component
// must emit no markup.
// ---------------------------------------------------------------------------

describe("VoiceInputButton SSR output", () => {
  test("renders nothing when the feature is unsupported (SSR snapshot)", () => {
    const html = renderToStaticMarkup(
      <VoiceInputButton onTranscript={() => {}} />,
    );
    expect(html).toBe("");
  });
});

// ---------------------------------------------------------------------------
// errorCodeForReason — discriminated mapping from daemon STT failure category
// to the string code consumed by `formatVoiceError` in `AssistantPageClient`.
// ---------------------------------------------------------------------------

describe("errorCodeForReason", () => {
  test("maps each failure reason to a stable, user-actionable code", () => {
    expect(errorCodeForReason("config-missing")).toBe("stt-not-configured");
    expect(errorCodeForReason("audio-rejected")).toBe("stt-audio-rejected");
    expect(errorCodeForReason("auth-failed")).toBe("stt-auth-failed");
    expect(errorCodeForReason("rate-limited")).toBe("stt-rate-limited");
    expect(errorCodeForReason("provider-error")).toBe("stt-provider-error");
    expect(errorCodeForReason("unavailable")).toBe("stt-unavailable");
    expect(errorCodeForReason("timeout")).toBe("stt-timeout");
    expect(errorCodeForReason("network")).toBe("network");
    expect(errorCodeForReason("aborted")).toBe("aborted");
    expect(errorCodeForReason("unknown")).toBe("transcription-failed");
  });
});

// ---------------------------------------------------------------------------
// LUM-1387 regression — `MediaRecorder.start()` must not be invoked with a
// sub-second timeslice.
//
// Safari's MP4 muxer (AVAssetWriter) emits fragmented or empty Blobs when
// asked to deliver chunks faster than once per second (WebKit bug 301507);
// the resulting fMP4 is not a valid standalone MP4 and Whisper rejects it.
// The web client only consumes the concatenated blob on stop — there is no
// streaming consumer of `dataavailable` chunks today — so the timeslice
// argument is never beneficial in batch mode. When the WS streaming
// consumer (TODO in `stt-api.ts`) lands, the timeslice may come back paired
// with that consumer.
// ---------------------------------------------------------------------------

describe("MediaRecorder.start() invocation (LUM-1387)", () => {
  test("is called with no arguments when recording starts", async () => {
    type StartCall = unknown[];
    const startCalls: StartCall[] = [];

    class FakeMediaRecorder {
      static isTypeSupported(_t: string) {
        return true;
      }
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e?: unknown) => void) | null = null;
      state: "inactive" | "recording" | "paused" = "inactive";
      constructor(_stream: MediaStream, _opts?: { mimeType?: string }) {}
      start(...args: unknown[]) {
        startCalls.push(args);
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }

    const fakeStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    // Patch only the global APIs the recording flow needs; the happy-dom
    // preload owns the rest of `window` / `navigator` and React-DOM relies
    // on `navigator.userAgent` etc., so we must not replace those wholesale.
    const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown })
      .MediaRecorder;
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;

    (globalThis as { MediaRecorder?: unknown }).MediaRecorder =
      FakeMediaRecorder as unknown as typeof MediaRecorder;
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => fakeStream,
    });

    try {
      const ref = createRef<{ start: () => void; stop: () => void }>();

      render(
        <VoiceInputButton
          ref={ref}
          onTranscript={() => {}}
          assistantId="test-assistant"
        />,
      );

      await act(async () => {
        ref.current?.start();
      });

      await waitFor(() => {
        expect(startCalls.length).toBe(1);
      });

      expect(startCalls[0]).toEqual([]);
      cleanup();
    } finally {
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder =
        originalMediaRecorder;
      if (originalGetUserMedia) {
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: originalGetUserMedia,
        });
      } else {
        // No original implementation — leave the descriptor we installed.
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Processing-state UI — when the user clicks stop, the recorder's `onstop`
// callback transitions the state machine from `recording` to `processing`
// for the duration of the async STT (and downstream dictation cleanup) call.
// During that window the button must surface an "in-flight" affordance so
// the user knows the recording wasn't lost. Mirrors macOS DictationOverlay's
// NSProgressIndicator + "Processing..." label for the same phase.
// ---------------------------------------------------------------------------

describe("processing-state UI (post-stop, transcription in flight)", () => {
  test("renders aria-busy + disabled while STT is pending", async () => {
    class FakeMediaRecorder {
      static isTypeSupported(_t: string) {
        return true;
      }
      static lastInstance: FakeMediaRecorder | null = null;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e?: unknown) => void) | null = null;
      state: "inactive" | "recording" | "paused" = "inactive";
      constructor(_stream: MediaStream, _opts?: { mimeType?: string }) {
        FakeMediaRecorder.lastInstance = this;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        // Seed a chunk so the recorder.onstop branch enters the
        // postSttTranscribe path (otherwise it short-circuits to vsReset).
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
        this.state = "inactive";
        this.onstop?.();
      }
    }

    const fakeStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown })
      .MediaRecorder;
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    const originalFetch = globalThis.fetch;

    (globalThis as { MediaRecorder?: unknown }).MediaRecorder =
      FakeMediaRecorder as unknown as typeof MediaRecorder;
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => fakeStream,
    });
    document.cookie = "csrftoken=test-csrf; path=/";

    // Fetch hangs — keeps the state machine pinned in `processing`.
    globalThis.fetch = (() =>
      new Promise(() => {})) as unknown as typeof globalThis.fetch;

    try {
      const ref = createRef<{ start: () => void; stop: () => void }>();

      const { container } = render(
        <VoiceInputButton
          ref={ref}
          onTranscript={() => {}}
          assistantId="test-assistant"
        />,
      );

      await act(async () => {
        ref.current?.start();
      });
      await waitFor(() => {
        expect(FakeMediaRecorder.lastInstance).not.toBeNull();
      });

      // Recording state — not yet processing.
      const recordingButton = container.querySelector("button");
      expect(recordingButton?.getAttribute("aria-busy")).toBe("false");
      expect(recordingButton?.getAttribute("aria-pressed")).toBe("true");

      await act(async () => {
        ref.current?.stop();
      });

      // After onstop fires, the reducer is in `processing` and stays there
      // because fetch never resolves. The button is disabled and aria-busy.
      await waitFor(() => {
        const button = container.querySelector("button");
        expect(button?.hasAttribute("disabled")).toBe(true);
        expect(button?.getAttribute("aria-busy")).toBe("true");
      });

      const processingButton = container.querySelector("button");
      expect(processingButton?.getAttribute("aria-label")).toBe(
        "Transcribing in progress",
      );

      cleanup();
    } finally {
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder =
        originalMediaRecorder;
      if (originalGetUserMedia) {
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: originalGetUserMedia,
        });
      }
      globalThis.fetch = originalFetch;
    }
  });

  // Push-to-talk consumes the imperative handle to start a session without
  // touching the button. While the on-screen button is `disabled` + `aria-busy`
  // during processing, the handle must reject `start()` calls too — otherwise
  // a held PTT key during the STT round-trip would spawn a new session,
  // increment `sessionIdRef`, and silently drop the in-flight transcript.
  test("imperative start() is a no-op while voice state is processing", async () => {
    class FakeMediaRecorder {
      static isTypeSupported(_t: string) {
        return true;
      }
      static instances = 0;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e?: unknown) => void) | null = null;
      state: "inactive" | "recording" | "paused" = "inactive";
      constructor(_stream: MediaStream, _opts?: { mimeType?: string }) {
        FakeMediaRecorder.instances += 1;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
        this.state = "inactive";
        this.onstop?.();
      }
    }

    const fakeStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown })
      .MediaRecorder;
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    const originalFetch = globalThis.fetch;

    (globalThis as { MediaRecorder?: unknown }).MediaRecorder =
      FakeMediaRecorder as unknown as typeof MediaRecorder;
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => fakeStream,
    });
    document.cookie = "csrftoken=test-csrf; path=/";
    globalThis.fetch = (() =>
      new Promise(() => {})) as unknown as typeof globalThis.fetch;

    try {
      const ref = createRef<{ start: () => void; stop: () => void }>();

      const { container } = render(
        <VoiceInputButton
          ref={ref}
          onTranscript={() => {}}
          assistantId="test-assistant"
        />,
      );

      await act(async () => {
        ref.current?.start();
      });
      await waitFor(() => {
        expect(FakeMediaRecorder.instances).toBe(1);
      });

      await act(async () => {
        ref.current?.stop();
      });

      // We're now in the `processing` phase — fetch hangs indefinitely.
      await waitFor(() => {
        const button = container.querySelector("button");
        expect(button?.getAttribute("aria-busy")).toBe("true");
      });

      // Calling start() while processing must NOT create a new recorder
      // (would have been instances === 2 if the handle had let it through).
      await act(async () => {
        ref.current?.start();
      });

      // Allow any spurious async work to settle so the assertion is meaningful.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeMediaRecorder.instances).toBe(1);

      cleanup();
    } finally {
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder =
        originalMediaRecorder;
      if (originalGetUserMedia) {
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: originalGetUserMedia,
        });
      }
      globalThis.fetch = originalFetch;
    }
  });
});
