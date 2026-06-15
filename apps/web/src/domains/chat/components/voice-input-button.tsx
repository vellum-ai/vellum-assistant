
import { Loader2, Mic, StopCircle } from "lucide-react";
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useSyncExternalStore,
} from "react";
import * as Sentry from "@sentry/react";

import {
  startDictationStream,
  type DictationStreamHandle,
} from "@/domains/chat/voice/dictation-stream";
import {
  startNativeDictationPartials,
  transcribeNativeAudioBlob,
  type StopNativeDictationPartials,
} from "@/runtime/native-dictation-partials";
import {
    postSttTranscribe,
    prefersMacosNativeStt,
    type SttFailureReason,
} from "@/domains/chat/voice/stt-api";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useVellumCommands } from "@/runtime/vellum-commands";
import { getVoiceInputMediaStream } from "@/utils/voice-input-device";
import { Button, cn } from "@vellumai/design-library";

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
 * by `formatVoiceError`. Kept as a pure helper so the reason taxonomy can
 * evolve without touching the recording flow.
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
// Session breadcrumbs
// ---------------------------------------------------------------------------

type DictationSessionOutcome =
  | "completed"
  | "empty"
  | "error"
  | "cancelled"
  | "aborted";

/**
 * One breadcrumb per dictation session, emitted when the session reaches a
 * terminal state. Carries only metrics (duration, locale, final transcript
 * length) — never the transcript itself, which is user speech content and
 * must not reach Sentry.
 *
 * @see https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/
 */
function addDictationSessionBreadcrumb(
  outcome: DictationSessionOutcome,
  durationMs: number,
  finalLength: number,
): void {
  Sentry.addBreadcrumb({
    category: "dictation",
    level: "info",
    message: `dictation session ${outcome}`,
    data: {
      outcome,
      durationMs,
      locale: typeof navigator !== "undefined" ? navigator.language : "unknown",
      finalLength,
    },
  });
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
  onError?: (error: string | null) => void;
  onStreamReady?: (stream: MediaStream | null) => void;
  assistantId?: string | null;
  disabled?: boolean;
  onBeforeStart?: () => boolean | Promise<boolean>;
  renderButton?: boolean;
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
    onError,
    onStreamReady,
    assistantId,
    disabled = false,
    onBeforeStart,
    renderButton = true,
  },
  ref,
) {
  const supported = useSyncExternalStore(
    () => () => {},
    () => isBatchSttSupported(),
    () => false,
  );

  const phase = useVoiceRecordingStore.use.phase();
  const {
    startRecording: vsStartRecording,
    stopRecording: vsStopRecording,
    finalize: vsFinalize,
    fail: vsFail,
    reset: vsReset,
  } = useVoiceRecordingStore.getState();
  const recording = phase === "recording";

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const cancelledStartRef = useRef(false);
  // Guard so recorder.onstop (which always fires after onerror) doesn't
  // overwrite the error state with a vsReset/vsFinalize transition.
  const erroredRef = useRef(false);
  // Set by cancelRecording (Esc) — recorder.onstop still fires for teardown
  // but must discard the captured audio instead of transcribing it.
  const discardedRef = useRef(false);
  // Wall-clock start of the live recording, for the session breadcrumb's
  // duration (recording time only, not the STT round trip).
  const sessionStartedAtRef = useRef(0);
  // Monotonic session counter — incremented on each startRecording call.
  // The async STT completion captures the current value and skips state
  // mutations if a newer session has started since.
  const sessionIdRef = useRef(0);

  // Web Speech API fallback — runs in parallel with MediaRecorder to
  // provide interim transcripts and a fallback transcript when daemon
  // STT is unavailable (mirrors macOS SFSpeechRecognizer fallback).
  const speechRecRef = useRef<SpeechRecognitionInstance | null>(null);
  const speechAccumulatorRef = useRef("");

  // Daemon streaming STT session — the primary source of live interim
  // transcripts. Web Speech is non-functional inside the Electron shell
  // (Chromium ships the API without the speech service behind it), so
  // without this, dictation there shows no words as they're spoken.
  // Interim display only; the batch transcribe-on-stop flow below stays
  // the authority for the final text.
  const dictationStreamRef = useRef<DictationStreamHandle | null>(null);

  // Native helper speech-recognition partials — the fallback live-text
  // source when the daemon stream can't start at all (no self-hosted
  // gateway ingress; platform-managed assistants ride the platform proxy,
  // which has no WebSocket path). Same role the native recognizer played
  // in the legacy Swift client.
  const nativePartialsStopRef = useRef<StopNativeDictationPartials | null>(
    null,
  );
  const nativePartialsTextRef = useRef("");
  // Resolves with the recognizer's final transcript of the whole utterance
  // after stopNativePartials — short dictations end before the first
  // partial, so this is the only reliable native text source.
  const nativeFinalPromiseRef = useRef<Promise<string | null> | null>(null);

  // Latest running transcript from the daemon stream — kept through
  // teardown so it can serve as the final-transcript fallback when batch
  // STT fails and the native recognizer wasn't available.
  const streamTranscriptRef = useRef("");

  const onStreamReadyRef = useRef(onStreamReady);
  onStreamReadyRef.current = onStreamReady;

  const onInterimTranscriptRef = useRef(onInterimTranscript);
  onInterimTranscriptRef.current = onInterimTranscript;

  // Interim transcripts fan out to the per-instance callback (composer
  // preview) AND the global recording store, so window-level consumers —
  // the Electron dictation overlay sync — see partials no matter which
  // button instance (chat composer or the global push-to-talk fallback)
  // owns the session.
  const publishInterim = useCallback((text: string) => {
    useVoiceRecordingStore.getState().setInterimTranscript(text);
    onInterimTranscriptRef.current?.(text);
  }, []);

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

  const stopDictationStream = useCallback(() => {
    dictationStreamRef.current?.stop();
    dictationStreamRef.current = null;
  }, []);

  const stopNativePartials = useCallback(() => {
    // Deliberately leaves nativePartialsTextRef intact: stopRecording runs
    // this before recorder.onstop reads the text as the final-transcript
    // fallback. startRecording resets it for the next session.
    const stop = nativePartialsStopRef.current;
    nativePartialsStopRef.current = null;
    if (!stop) return;
    // The promise resolves once the helper's recognizer drains the session
    // (dictation.finalized); recorder.onstop awaits it alongside batch STT.
    const final = stop();
    if (final) nativeFinalPromiseRef.current = final;
  }, []);

  // Run the mac helper's local speech recognizer alongside the whole
  // recording — the live-text source when no daemon stream goes live, and
  // the offline final-transcript safety net when batch STT can't reach its
  // provider. It runs for the full session rather than starting on stream
  // failure because failure isn't a reliable signal: with a local daemon the
  // stream looks healthy (localhost connects, `ready` arrives) while the
  // provider behind it is unreachable, so it just stays silent. Same role
  // the recognizer played in the legacy Swift client.
  const startNativePartials = useCallback(() => {
    if (!mediaRecorderRef.current || nativePartialsStopRef.current) {
      console.info(
        "dictation: native partials not started (session ended or already running)",
      );
      return;
    }
    let partialCount = 0;
    void startNativeDictationPartials(
      (text) => {
        partialCount += 1;
        if (partialCount === 1 || partialCount % 25 === 0) {
          // Count/length only — transcript content must never be logged.
          console.info(
            `dictation: native partial #${partialCount} chars=${text.length}`,
          );
        }
        nativePartialsTextRef.current = text;
        if (!dictationStreamRef.current?.isLive()) {
          publishInterim(text);
        }
      },
      // Feed the helper the recording stream's own PCM — it must not open
      // the device itself (a second capture client on the same device reads
      // silence or kills this recording's stream).
      { stream: streamRef.current ?? undefined },
    ).then((stop) => {
      // The unavailable case logs its reason in native-dictation-partials.
      if (!stop) return;
      console.info("dictation: native partials running");
      // The session may have ended while the helper call was in flight.
      if (!mediaRecorderRef.current) {
        stop();
        return;
      }
      nativePartialsStopRef.current = stop;
    });
  }, [publishInterim]);

  const stopRecording = useCallback(() => {
    cancelledStartRef.current = true;
    stopSpeechRecognition();
    stopDictationStream();
    stopNativePartials();
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
  }, [
    vsStopRecording,
    stopSpeechRecognition,
    stopDictationStream,
    stopNativePartials,
  ]);

  /**
   * Discard the in-flight recording session: stop capture without
   * transcribing or inserting anything. `recorder.onstop` still fires and
   * performs the usual teardown; `discardedRef` makes it skip the STT path.
   */
  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    discardedRef.current = true;
    stopSpeechRecognition();
    stopDictationStream();
    stopNativePartials();
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    vsReset();
  }, [
    stopSpeechRecognition,
    stopDictationStream,
    stopNativePartials,
    vsReset,
  ]);

  // Esc during recording discards the partial result. Capture phase so it
  // wins over composer/modal Escape handlers while a recording is live. Two
  // instances can be mounted per window (chat composer + the global
  // push-to-talk fallback) and both see the shared store phase; the
  // recorder-ownership guard keeps the non-recording instance inert.
  useEffect(() => {
    if (!recording) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!mediaRecorderRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancelRecording();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [recording, cancelRecording]);

  // The DOM listener above only sees Escape while a Vellum window has
  // focus. During system-wide push-to-talk dictation into another app the
  // Electron escape monitor owns Escape and relays it as a command; the
  // same recorder-ownership guard applies.
  useVellumCommands({
    cancelDictation: () => {
      if (!mediaRecorderRef.current) return;
      cancelRecording();
    },
  });

  useEffect(() => {
    if (disabled && recording) {
      // Do NOT stop the recording here. `disabled` composes transient
      // states — offline SSE recovery flips `isLoadingHistory` every few
      // seconds, which used to kill an explicit user dictation ~50ms in,
      // before the offline Apple Speech fallback could hear a single
      // word. The press-to-stop lifecycle owns an in-flight session;
      // `disabled` only gates starting new ones.
      console.info("dictation: button disabled mid-recording (continuing)");
    }
  }, [disabled, recording]);

  useEffect(() => {
    return () => {
      transcribeAbortRef.current?.abort();
      stopSpeechRecognition();
      stopDictationStream();
      stopNativePartials();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Ignore.
        }
      }
      releaseStream();
      useVoiceRecordingStore.getState().reset();
    };
  }, [
    releaseStream,
    stopSpeechRecognition,
    stopDictationStream,
    stopNativePartials,
  ]);

  const startRecording = useCallback(async () => {
    if (mediaRecorderRef.current) return;
    cancelledStartRef.current = false;
    discardedRef.current = false;
    const sessionId = ++sessionIdRef.current;
    // Honor the explicit "macOS Native Dictation" provider choice for the
    // whole session: no daemon stream, no batch upload — the helper's
    // recognizer (already running for every session) is the authority.
    const nativeSttForced = prefersMacosNativeStt();

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
    nativePartialsTextRef.current = "";
    nativeFinalPromiseRef.current = null;
    streamTranscriptRef.current = "";
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
          // Streaming STT and native helper partials both take priority
          // over Web Speech partials to avoid competing UI updates (the
          // legacy client's rule). The accumulator above still builds — it
          // stays the batch fallback.
          if (
            !dictationStreamRef.current?.isLive() &&
            !nativePartialsTextRef.current
          ) {
            publishInterim(interim);
          }
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
      stream = await getVoiceInputMediaStream();
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
    for (const track of stream.getAudioTracks?.() ?? []) {
      track.onended = () => {
        // Not a user stop: the OS revoked the capture (device unplugged,
        // exclusive-claim contention). MediaRecorder will fire onstop on
        // its own; this line is the field-debuggable distinction.
        console.warn("dictation: audio track ended unexpectedly");
      };
    }
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
      const durationMs = Date.now() - sessionStartedAtRef.current;
      mediaRecorderRef.current = null;
      if (useVoiceRecordingStore.getState().phase === "recording") {
        vsStopRecording();
      }
      releaseStream();
      stopSpeechRecognition();
      stopDictationStream();
      const streamText = streamTranscriptRef.current;
      const nativePartialText = nativePartialsTextRef.current;
      stopNativePartials();
      const pendingNativeFinal = nativeFinalPromiseRef.current;
      nativeFinalPromiseRef.current = null;
      publishInterim("");

      if (discardedRef.current) {
        discardedRef.current = false;
        chunksRef.current = [];
        speechAccumulatorRef.current = "";
        nativePartialsTextRef.current = "";
        streamTranscriptRef.current = "";
        // Re-assert idle: a stop() racing in between cancelRecording and
        // this handler (e.g. the push-to-talk key-up after Esc) can have
        // moved the store to "processing".
        vsReset();
        addDictationSessionBreadcrumb("cancelled", durationMs, 0);
        return;
      }

      if (erroredRef.current) {
        addDictationSessionBreadcrumb("error", durationMs, 0);
        return;
      }

      const chunks = chunksRef.current;
      chunksRef.current = [];
      const fallbackText = speechAccumulatorRef.current;
      speechAccumulatorRef.current = "";
      if (
        chunks.length === 0 &&
        !fallbackText &&
        !nativePartialText &&
        !streamText &&
        !pendingNativeFinal
      ) {
        addDictationSessionBreadcrumb("empty", durationMs, 0);
        vsReset();
        return;
      }

      const audioBlob = chunks.length > 0 ? new Blob(chunks, { type: mimeType }) : null;
      const abortCtrl = new AbortController();
      transcribeAbortRef.current = abortCtrl;

      void (async () => {
        // Whole-recording native transcription starts concurrently with
        // batch STT: it's local and takes a few seconds, while an offline
        // batch attempt burns its full provider timeout before failing —
        // sequencing them stacked into ~30s of "Processing".
        const blobTextPromise: Promise<string | null> = audioBlob
          ? transcribeNativeAudioBlob(audioBlob)
          : Promise.resolve(null);

        let text = "";
        let daemonFailure: SttFailureReason | null = null;
        try {
          if (audioBlob && assistantId && !nativeSttForced) {
            if (typeof navigator !== "undefined" && navigator.onLine === false) {
              // Provably offline — don't burn the provider timeout to learn
              // what we already know.
              console.info("dictation: skipping batch STT (offline)");
              daemonFailure = "network";
            } else {
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
          }
        } catch (err) {
          // postSttTranscribe is meant to never throw — if it does, log it
          // and fall through to the unknown-failure path.
          console.warn("VoiceInputButton: STT transcribe threw", err);
          daemonFailure = "unknown";
        }

        // The recognizer keeps draining briefly after the recording ends —
        // its final result is the complete utterance, where the live
        // partials of a 1-2s dictation are usually still empty. The await
        // overlaps the batch POST above, so it adds ~no wall-clock time.
        let nativeText = nativePartialText;
        if (pendingNativeFinal) {
          const finalText = await pendingNativeFinal;
          if (finalText) {
            nativeText = finalText;
          }
        }

        // Batch text is the authority. When it fails (offline, provider
        // down), recognize the COMPLETE recorded audio natively — the
        // streamed session races pump warmup and recognition latency on
        // short dictations and can miss the leading words, so it is only
        // the fallback's fallback. The Web Speech accumulator only matters
        // in plain browsers — inside Electron the API ships without a
        // speech service, so it stays empty.
        let blobText = "";
        if (!text) {
          blobText = (await blobTextPromise) ?? "";
        }

        // Character counts only — transcript content must never be logged.
        console.info(
          `dictation: finalize batchChars=${text.length} blobChars=${blobText.length} nativeChars=${nativeText.length} streamChars=${streamText.length} webChars=${fallbackText.length} failure=${daemonFailure ?? "none"} forcedNative=${nativeSttForced}`,
        );

        if (!text && blobText) {
          text = blobText;
        }
        if (!text && nativeText) {
          text = nativeText;
        }
        if (!text && streamText) {
          text = streamText;
        }
        if (!text && fallbackText) {
          text = fallbackText;
        }

        // A newer session started while we were awaiting — don't
        // overwrite its voice state with this stale completion.
        if (sessionIdRef.current !== sessionId) return;

        try {
          if (text) {
            addDictationSessionBreadcrumb("completed", durationMs, text.length);
            await onTranscript(text);
          } else if (daemonFailure) {
            // The user-cancelled `aborted` reason should not trigger a
            // visible error — it's the expected outcome of stop().
            if (daemonFailure === "aborted") {
              addDictationSessionBreadcrumb("aborted", durationMs, 0);
              vsReset();
              return;
            }
            addDictationSessionBreadcrumb("error", durationMs, 0);
            const code = errorCodeForReason(daemonFailure);
            onError?.(code);
            vsFail(code);
            return;
          } else if (nativeSttForced && audioBlob) {
            // Audio was captured but the forced-native recognizer produced
            // nothing — most likely macOS Dictation (and its on-device
            // model) isn't enabled. Surface that instead of resetting
            // silently; there is no daemon failure to report here.
            addDictationSessionBreadcrumb("error", durationMs, 0);
            onError?.("native-stt-no-transcript");
            vsFail("native-stt-no-transcript");
            return;
          } else {
            addDictationSessionBreadcrumb("empty", durationMs, 0);
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
      releaseStream();
      stopSpeechRecognition();
      stopDictationStream();
      stopNativePartials();
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
      sessionStartedAtRef.current = Date.now();
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

    // Recording is live — open the daemon streaming session for interim
    // transcripts. Null / later failure means no live partials from that
    // source; the recorder above is untouched either way. A forced-native
    // session never opens the stream: the helper recognizer below is its
    // only transcript source.
    stopDictationStream();
    stopNativePartials();
    if (!nativeSttForced) {
      dictationStreamRef.current = startDictationStream({
        onPartial: (text) => {
          streamTranscriptRef.current = text;
          publishInterim(text);
        },
      });
    }

    startNativePartials();
  }, [
    assistantId,
    onBeforeStart,
    onError,
    onTranscript,
    publishInterim,
    releaseStream,
    startNativePartials,
    stopSpeechRecognition,
    stopDictationStream,
    stopNativePartials,
    vsStartRecording,
    vsStopRecording,
    vsFail,
    vsFinalize,
    vsReset,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      start: () => {
        if (disabled || !assistantId || !supported) return;
        // Refuse to start while the previous session is still transcribing.
        // Mirrors the visual `disabled` + `aria-busy` state on the button
        // and prevents push-to-talk from silently dropping the in-flight
        // transcript by incrementing the session id mid-flight.
        if (useVoiceRecordingStore.getState().phase === "processing") return;
        startRecording();
      },
      stop: stopRecording,
    }),
    [assistantId, disabled, startRecording, stopRecording, supported],
  );

  const isNative = useIsNativePlatform();

  if (!renderButton || !supported || !assistantId) return null;

  // The button has three visible states:
  //   - idle:       mic icon, click to start
  //   - recording:  stop-circle icon, click to stop
  //   - processing: spinning loader, disabled — STT and dictation cleanup are
  //                 in flight and the transcript will land in the composer
  //                 momentarily. The visible motion is the user-facing
  //                 "still working" signal (matches macOS DictationOverlay's
  //                 NSProgressIndicator + "Processing..." label).
  const processing = phase === "processing";
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
      className={cn(
        "[--vbtn-fg:var(--content-secondary)]",
        isNative && recording && "h-12 w-12 max-md:h-12 max-md:w-12",
      )}
    />
  );
});
