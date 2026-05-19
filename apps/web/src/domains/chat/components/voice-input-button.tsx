
import { Loader2, Mic, StopCircle } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "@vellum/design-library";
import {
  postSttTranscribe,
  type SttFailureReason,
} from "@/domains/voice/stt-api.js";
import {
  useVoiceRecordingState,
  type VoiceRecordingState,
} from "@/domains/voice/voice-recording-state.js";

// ---------------------------------------------------------------------------
// MIME type selection
// ---------------------------------------------------------------------------

/**
 * Pick the best audio MIME type the current browser supports.
 *
 * Priority order mirrors browser support:
 *   1. audio/webm;codecs=opus  — Chrome, Arc, Edge, Brave
 *   2. audio/ogg;codecs=opus   — Firefox
 *   3. audio/mp4               — Safari (via MediaRecorder on iOS/macOS 15+)
 *
 * Returns null if MediaRecorder is unavailable or no supported type is found.
 */
export function getBestMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

// ---------------------------------------------------------------------------
// Web Speech API types (fallback recognizer)
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/**
 * Returns the browser's `SpeechRecognition` constructor when usable.
 *
 * Runs in parallel with `MediaRecorder` to provide interim transcripts
 * and a fallback when the daemon STT provider is unconfigured — the
 * web equivalent of macOS's `SFSpeechRecognizer` fallback. Detects via
 * the constructor itself; iOS WKWebView requires
 * `NSSpeechRecognitionUsageDescription` in `Info.plist` and the user
 * granting the speech-recognition permission, both of which surface
 * runtime failures through the recognizer's own `onerror` event.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
 * @see https://developer.apple.com/documentation/speech/sfspeechrecognizer
 *
 * Exported for unit testing.
 */
export function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as SpeechRecognitionWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the runtime can capture audio for upload to daemon
 * STT.
 *
 * Requires `getUserMedia`, `MediaRecorder`, and a usable MIME type.
 * These are present in modern Chromium/Firefox/Safari and in Capacitor
 * iOS WKWebView (deployment target ≥ 14.5 for `MediaRecorder`). The
 * captured audio is posted to the daemon's STT service, which fans out
 * to the user's configured provider, so the same path serves every
 * webview-based client. Returns false during SSR.
 *
 * Exported for unit testing; prefer the component's own `supported`
 * signal inside React code.
 */
export function isBatchSttSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    getBestMimeType() !== null
  );
}

// ---------------------------------------------------------------------------
// Error code mapping
// ---------------------------------------------------------------------------

/**
 * Map a structured STT failure reason to the string `onError` code consumed
 * by `formatVoiceError` in `AssistantPageClient`. Kept as a pure helper so
 * the reason taxonomy can evolve without touching the recording flow.
 */
export function errorCodeForReason(reason: SttFailureReason): string {
  switch (reason) {
    case "config-missing":
      return "stt-not-configured";
    case "audio-rejected":
      return "stt-audio-rejected";
    case "auth-failed":
      return "stt-auth-failed";
    case "rate-limited":
      return "stt-rate-limited";
    case "provider-error":
      return "stt-provider-error";
    case "unavailable":
      return "stt-unavailable";
    case "timeout":
      return "stt-timeout";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    case "unknown":
    default:
      return "transcription-failed";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VoiceInputButtonHandle {
  start: () => void;
  stop: () => void;
}

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void | Promise<void>;
  onInterimTranscript?: (text: string) => void;
  onRecordingChange?: (recording: boolean) => void;
  onStateChange?: (state: VoiceRecordingState) => void;
  onError?: (error: string | null) => void;
  onStreamReady?: (stream: MediaStream | null) => void;
  assistantId?: string | null;
  disabled?: boolean;
  onBeforeStart?: () => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const VoiceInputButton = forwardRef<
  VoiceInputButtonHandle,
  VoiceInputButtonProps
>(function VoiceInputButton(
  {
    onTranscript,
    onInterimTranscript,
    onRecordingChange,
    onStateChange,
    onError,
    onStreamReady,
    assistantId,
    disabled = false,
    onBeforeStart,
  },
  ref,
) {
  const supported = useSyncExternalStore(
    () => () => {},
    () => isBatchSttSupported(),
    () => false,
  );

  const [recording, setRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const cancelledStartRef = useRef(false);
  // Guard so recorder.onstop (which always fires after onerror) doesn't
  // overwrite the error state with a vsReset/vsFinalize transition.
  const erroredRef = useRef(false);
  // Monotonic session counter — incremented on each startRecording call.
  // The async STT completion captures the current value and skips state
  // mutations if a newer session has started since.
  const sessionIdRef = useRef(0);

  // Web Speech API fallback — runs in parallel with MediaRecorder to
  // provide interim transcripts and a fallback transcript when daemon
  // STT is unavailable (mirrors macOS SFSpeechRecognizer fallback).
  const speechRecRef = useRef<SpeechRecognitionInstance | null>(null);
  const speechAccumulatorRef = useRef("");

  const {
    state: voiceState,
    startRecording: vsStartRecording,
    stopRecording: vsStopRecording,
    finalize: vsFinalize,
    fail: vsFail,
    reset: vsReset,
  } = useVoiceRecordingState();

  useEffect(() => {
    onStateChange?.(voiceState);
  }, [voiceState, onStateChange]);

  const onStreamReadyRef = useRef(onStreamReady);
  onStreamReadyRef.current = onStreamReady;

  const onInterimTranscriptRef = useRef(onInterimTranscript);
  onInterimTranscriptRef.current = onInterimTranscript;

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    onStreamReadyRef.current?.(null);
  }, []);

  const stopSpeechRecognition = useCallback(() => {
    const rec = speechRecRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // Already stopped.
      }
      speechRecRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    cancelledStartRef.current = true;
    stopSpeechRecognition();
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    vsStopRecording();
  }, [vsStopRecording, stopSpeechRecognition]);

  useEffect(() => {
    if (disabled && recording) {
      stopRecording();
    }
  }, [disabled, recording, stopRecording]);

  useEffect(() => {
    return () => {
      transcribeAbortRef.current?.abort();
      stopSpeechRecognition();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Ignore.
        }
      }
      releaseStream();
    };
  }, [releaseStream, stopSpeechRecognition]);

  const startRecording = useCallback(async () => {
    if (mediaRecorderRef.current) return;
    cancelledStartRef.current = false;
    const sessionId = ++sessionIdRef.current;

    if (onBeforeStart) {
      let proceed: boolean;
      try {
        proceed = await onBeforeStart();
      } catch {
        return;
      }
      if (!proceed || cancelledStartRef.current || mediaRecorderRef.current) {
        return;
      }
    }

    const mimeType = getBestMimeType();
    if (!mimeType) {
      onError?.("service-not-allowed");
      vsFail("service-not-allowed");
      return;
    }

    // Start Web Speech API BEFORE getUserMedia so it establishes its audio
    // pipeline first. Starting it after getUserMedia claims the mic causes
    // Chrome to silently starve SpeechRecognition of audio input.
    speechAccumulatorRef.current = "";
    const Ctor = getSpeechRecognitionCtor();
    if (Ctor) {
      try {
        const speechRec = new Ctor();
        speechRec.lang =
          typeof navigator !== "undefined" ? navigator.language : "en-US";
        speechRec.continuous = true;
        speechRec.interimResults = true;
        speechRec.maxAlternatives = 1;

        speechRec.onresult = (event: SpeechRecognitionEvent) => {
          let interim = "";
          let accumulated = "";
          for (let i = 0; i < event.results.length; i += 1) {
            const result = event.results[i];
            if (!result?.[0]) continue;
            if (result.isFinal) {
              accumulated += result[0].transcript;
            } else {
              interim += result[0].transcript;
            }
          }
          speechAccumulatorRef.current = accumulated + interim;
          onInterimTranscriptRef.current?.(interim);
        };

        speechRec.onerror = () => {
          speechRecRef.current = null;
        };

        speechRec.onend = () => {
          speechRecRef.current = null;
        };

        speechRec.start();
        speechRecRef.current = speechRec;
      } catch {
        // Browser doesn't support it — continue without partials.
      }
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      stopSpeechRecognition();
      const code =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "not-allowed"
          : "audio-capture";
      onError?.(code);
      vsFail(code);
      return;
    }

    if (cancelledStartRef.current) {
      stopSpeechRecognition();
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    streamRef.current = stream;
    onStreamReadyRef.current?.(stream);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      stopSpeechRecognition();
      releaseStream();
      const msg = err instanceof Error ? err.message : "audio-capture";
      onError?.(msg);
      vsFail(msg);
      return;
    }
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];
    erroredRef.current = false;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    recorder.onstop = () => {
      mediaRecorderRef.current = null;
      setRecording(false);
      onRecordingChange?.(false);
      releaseStream();
      stopSpeechRecognition();
      onInterimTranscriptRef.current?.("");

      if (erroredRef.current) {
        return;
      }

      const chunks = chunksRef.current;
      chunksRef.current = [];
      const fallbackText = speechAccumulatorRef.current;
      speechAccumulatorRef.current = "";
      if (chunks.length === 0 && !fallbackText) {
        vsReset();
        return;
      }

      const audioBlob = chunks.length > 0 ? new Blob(chunks, { type: mimeType }) : null;
      const abortCtrl = new AbortController();
      transcribeAbortRef.current = abortCtrl;

      void (async () => {
        let text = "";
        let daemonFailure: SttFailureReason | null = null;
        try {
          if (audioBlob && assistantId) {
            const result = await postSttTranscribe(
              audioBlob,
              assistantId,
              abortCtrl.signal,
            );
            if (result.status === "ok") {
              text = result.text.trim();
            } else {
              daemonFailure = result.reason;
            }
          }
        } catch (err) {
          // postSttTranscribe is meant to never throw — if it does, log it
          // and fall through to the unknown-failure path.
          console.warn("VoiceInputButton: STT transcribe threw", err);
          daemonFailure = "unknown";
        }

        if (!text && fallbackText) {
          text = fallbackText;
        }

        // A newer session started while we were awaiting — don't
        // overwrite its voice state with this stale completion.
        if (sessionIdRef.current !== sessionId) return;

        try {
          if (text) {
            await onTranscript(text);
          } else if (daemonFailure) {
            // The user-cancelled `aborted` reason should not trigger a
            // visible error — it's the expected outcome of stop().
            if (daemonFailure === "aborted") {
              vsReset();
              return;
            }
            const code = errorCodeForReason(daemonFailure);
            onError?.(code);
            vsFail(code);
            return;
          } else {
            vsReset();
            return;
          }
        } catch {
          // Transcript delivery failed — still finalize.
        } finally {
          transcribeAbortRef.current = null;
        }
        vsFinalize();
      })();
    };

    recorder.onerror = () => {
      erroredRef.current = true;
      mediaRecorderRef.current = null;
      setRecording(false);
      onRecordingChange?.(false);
      releaseStream();
      stopSpeechRecognition();
      onError?.("audio-capture");
      vsFail("audio-capture");
    };

    try {
      // Do not pass a timeslice. The web client posts a single complete blob
      // to the batch /v1/stt/transcribe endpoint on stop — there is no
      // streaming consumer of `dataavailable` chunks today. Passing a
      // sub-second timeslice causes Safari's MP4 muxer (AVAssetWriter) to
      // emit fragmented or empty Blobs (see WebKit bug 301507 and the
      // 1-second minimum segment behaviour in `MediaRecorderPrivateWriter`),
      // which Whisper rejects — the visible LUM-1387 regression on iOS.
      // When a future change wires up the WS /v1/stt/stream consumer, the
      // timeslice should come back paired with that consumer.
      recorder.start();
      setRecording(true);
      onRecordingChange?.(true);
      vsStartRecording();
      onError?.(null);
    } catch (err) {
      mediaRecorderRef.current = null;
      stopSpeechRecognition();
      releaseStream();
      const msg = err instanceof Error ? err.message : "start-failed";
      onError?.(msg);
      vsFail(msg);
      return;
    }

  }, [
    assistantId,
    onBeforeStart,
    onError,
    onRecordingChange,
    onTranscript,
    releaseStream,
    stopSpeechRecognition,
    vsStartRecording,
    vsFail,
    vsFinalize,
    vsReset,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      start: () => {
        if (disabled || !assistantId) return;
        // Refuse to start while the previous session is still transcribing.
        // Mirrors the visual `disabled` + `aria-busy` state on the button
        // and prevents push-to-talk from silently dropping the in-flight
        // transcript by incrementing the session id mid-flight.
        if (voiceState.phase === "processing") return;
        startRecording();
      },
      stop: stopRecording,
    }),
    [assistantId, disabled, startRecording, stopRecording, voiceState.phase],
  );

  if (!supported || !assistantId) return null;

  // The button has three visible states:
  //   - idle:       mic icon, click to start
  //   - recording:  stop-circle icon, click to stop
  //   - processing: spinning loader, disabled — STT and dictation cleanup are
  //                 in flight and the transcript will land in the composer
  //                 momentarily. The visible motion is the user-facing
  //                 "still working" signal (matches macOS DictationOverlay's
  //                 NSProgressIndicator + "Processing..." label).
  const processing = voiceState.phase === "processing";
  const label = processing
    ? "Transcribing in progress"
    : recording
      ? "Stop recording"
      : "Start voice input";

  return (
    <Button
      variant="ghost"
      iconOnly={
        processing ? (
          <Loader2 className="animate-spin" strokeWidth={2} />
        ) : recording ? (
          <StopCircle strokeWidth={2} />
        ) : (
          <Mic strokeWidth={2} />
        )
      }
      onClick={() => {
        if (processing) return;
        if (recording) {
          stopRecording();
        } else {
          void startRecording();
        }
      }}
      disabled={disabled || processing}
      aria-label={label}
      aria-pressed={recording}
      aria-busy={processing}
      title={label}
      className="[--vbtn-fg:var(--content-secondary)]"
    />
  );
});
