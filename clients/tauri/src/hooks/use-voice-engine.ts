import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GatewayClient } from "../services/gateway-client.js";
import {
  type GatewayEventEnvelope,
  GatewayEventStream,
  type GatewayServerMessage,
} from "../services/gateway-events.js";
import {
  LiveVoiceClient,
  type LiveVoiceServerFrame,
} from "../services/live-voice-client.js";
import { MicStream } from "../services/mic-stream.js";
import { TtsPlayback } from "../services/tts-playback.js";
import type {
  ActivePlanStatus,
  AssistantConnection,
  AssistantMode,
  ConnectionStatus,
  TranscriptEntry,
  VoiceConfigSnapshot,
} from "../types.js";

interface UseVoiceEngineOptions {
  readonly connection: AssistantConnection | null;
  readonly voiceConfig: VoiceConfigSnapshot;
}

interface VoiceEngineApi {
  readonly mode: AssistantMode;
  readonly amplitude: number;
  readonly conversationActive: boolean;
  readonly wakeWordActive: boolean;
  /** Raw RMS at which the voice-activity wake fires. UI mirrors this. */
  readonly wakeThresholdRms: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly activePlan: ActivePlanStatus | null;
  readonly connection: ConnectionStatus;
  readonly sendText: (text: string) => Promise<void>;
  readonly toggleListening: () => Promise<void>;
  readonly cancelTts: () => void;
}

const ENTRY_TTL_MS = 5 * 60_000;
const MAX_TRANSCRIPT_ENTRIES = 80;
const LIVE_VOICE_TERMINAL_TIMEOUT_MS = 45_000;
// Voice-activity thresholds (raw float32 RMS, range [0, 1]).
//
// A fixed wake threshold is too brittle across microphone gain profiles:
// some users must speak loudly to exceed the trigger, others false-wake
// on keyboard/fan noise. We keep a very low floor and adapt upward from
// a rolling ambient RMS baseline.
const MIN_SPEECH_RMS = 0.008;
const SPEECH_WAKE_MIN_TRIGGER_RMS = 0.008;
const SPEECH_WAKE_MAX_TRIGGER_RMS = 0.022;
const SPEECH_WAKE_NOISE_MULTIPLIER = 2.2;
const SPEECH_WAKE_NOISE_ALPHA = 0.08;
const SPEECH_WAKE_TRIGGER_FRAMES = 3;
const SPEECH_WAKE_COOLDOWN_MS = 2_500;
const WAKE_THRESHOLD_UI_EPSILON = 0.001;
const VOICE_DEBUG = import.meta.env.DEV;
const LOCAL_TTS_VOICE = "Daniel";

/**
 * High-level voice + transcript orchestration. Manages:
 *   - SSE subscription for assistant text deltas
 *   - Mic capture with optional wake-word gating
 *   - Live-voice WebSocket lifecycle (start on wake, end on silence)
 *   - TTS playback with barge-in (cancel on user speech)
 *
 * Push-to-talk is exposed via {@link toggleListening} so the HUD's
 * quick command bar / hotkey can force-open a turn even when the
 * wake-word is disabled.
 */
export function useVoiceEngine(options: UseVoiceEngineOptions): VoiceEngineApi {
  const { connection, voiceConfig } = options;

  const [mode, setMode] = useState<AssistantMode>(
    connection ? "idle" : "offline",
  );
  const [amplitude, setAmplitude] = useState(0);
  const [conversationActive, setConversationActive] = useState(false);
  const [wakeWordActive, setWakeWordActive] = useState(false);
  const [wakeThresholdRms, setWakeThresholdRms] = useState(
    SPEECH_WAKE_MIN_TRIGGER_RMS,
  );
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [activePlan, setActivePlan] = useState<ActivePlanStatus | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    model: null,
    latencyMs: null,
    lastError: null,
  });

  const micRef = useRef<MicStream | null>(null);
  const liveVoiceRef = useRef<LiveVoiceClient | null>(null);
  const ttsRef = useRef<TtsPlayback | null>(null);
  const modeRef = useRef<AssistantMode>(connection ? "idle" : "offline");
  // The mic-lifecycle effect must NOT depend on `handleMicFrame` directly,
  // otherwise the cascading callback recreation (mode changes propagate
  // through handleVoiceFrame → startSession → handleMicFrame) would tear
  // down and rebuild the AudioContext on every state transition — which
  // is exactly what was killing audio capture mid-turn and producing
  // chunks: 0 on the server. Instead we keep the latest handleMicFrame
  // in a ref and call it from a stable closure.
  const handleMicFrameRef = useRef<
    ((samples: Int16Array, rms: number) => void) | null
  >(null);
  const eventStreamRef = useRef<GatewayEventStream | null>(null);
  const partialIdsRef = useRef<{ user: string | null; assistant: string | null }>({
    user: null,
    assistant: null,
  });
  const sessionActiveRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relistenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utteranceStartedAtRef = useRef(0);
  const speechWakeFramesRef = useRef(0);
  const speechWakeCooldownUntilRef = useRef(0);
  const wakeThresholdRmsRef = useRef(SPEECH_WAKE_MIN_TRIGGER_RMS);
  const ambientNoiseRmsRef = useRef(0.004);
  const startingSessionRef = useRef(false);
  const sentAudioFramesRef = useRef(0);
  const heardSpeechRef = useRef(false);
  const lastTurnHeardSpeechRef = useRef(false);
  const releaseSentRef = useRef(false);
  const assistantSpeechBufferRef = useRef("");
  const serverTtsAudioReceivedRef = useRef(false);
  const ttsFailureNotifiedRef = useRef(false);
  // Tracks whether the server currently has an active session bound to this
  // WebSocket. The server keeps the session alive until it receives an `end`
  // frame, errors, or the socket closes — so we need to know whether sending
  // `end` is safe (sending it without an active session triggers a state-error
  // frame).
  const serverSessionOpenRef = useRef(false);
  const conversationActiveRef = useRef(false);

  const gatewayClient = useMemo(
    () => (connection ? new GatewayClient(connection) : null),
    [connection],
  );

  const appendTranscript = useCallback(
    (entry: Omit<TranscriptEntry, "timestamp"> & { timestamp?: number }) => {
      const timestamp = entry.timestamp ?? Date.now();
      setTranscript((prev) => {
        const next = [...prev, { ...entry, timestamp }];
        return next.slice(-MAX_TRANSCRIPT_ENTRIES);
      });
    },
    [],
  );

  const updateTranscript = useCallback(
    (id: string, mutation: (current: TranscriptEntry) => TranscriptEntry) => {
      setTranscript((prev) => prev.map((entry) => (entry.id === id ? mutation(entry) : entry)));
    },
    [],
  );

  const appendSystemStatus = useCallback(
    (text: string) => {
      if (!VOICE_DEBUG) return;
      appendTranscript({
        id: cryptoId(),
        role: "system",
        text,
        state: "final",
      });
    },
    [appendTranscript],
  );

  const setConversationState = useCallback((active: boolean) => {
    conversationActiveRef.current = active;
    setConversationActive(active);
  }, []);

  const clearVoiceTimers = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (turnStartTimerRef.current) {
      clearTimeout(turnStartTimerRef.current);
      turnStartTimerRef.current = null;
    }
    if (terminalTimerRef.current) {
      clearTimeout(terminalTimerRef.current);
      terminalTimerRef.current = null;
    }
    if (relistenTimerRef.current) {
      clearTimeout(relistenTimerRef.current);
      relistenTimerRef.current = null;
    }
  }, []);

  const closeLiveVoiceSession = useCallback(() => {
    clearVoiceTimers();
    if (serverSessionOpenRef.current) {
      serverSessionOpenRef.current = false;
      liveVoiceRef.current?.end();
    }
    liveVoiceRef.current?.close();
    liveVoiceRef.current = null;
    sessionActiveRef.current = false;
    releaseSentRef.current = true;
  }, [clearVoiceTimers]);

  const armTerminalWatchdog = useCallback(() => {
    if (terminalTimerRef.current) clearTimeout(terminalTimerRef.current);
    terminalTimerRef.current = setTimeout(() => {
      terminalTimerRef.current = null;
      if (!serverSessionOpenRef.current) return;
      appendSystemStatus("Voice turn timed out; resetting the voice link.");
      closeLiveVoiceSession();
      setMode("idle");
    }, LIVE_VOICE_TERMINAL_TIMEOUT_MS);
  }, [appendSystemStatus, closeLiveVoiceSession]);


  useEffect(() => {
    if (!connection) {
      setConversationState(false);
      setMode("offline");
      return;
    }

    setMode("idle");
    const stream = new GatewayEventStream(connection, {
      onEvent: (event) => {
        ingestEvent(event, {
          updateTranscript,
          setTranscript,
          setActivePlan,
          partialIdsRef,
          setConnectionStatus,
          setMode,
          sessionActiveRef,
        });
      },
      onOpen: () => {
        setConnectionStatus((prev) => ({ ...prev, connected: true, lastError: null }));
      },
      onError: (err) => {
        setConnectionStatus((prev) => ({
          ...prev,
          connected: false,
          lastError: errorMessage(err),
        }));
      },
    });
    stream.start();
    eventStreamRef.current = stream;
    return () => {
      stream.stop();
      eventStreamRef.current = null;
    };
  }, [connection, setConversationState, updateTranscript]);

  const handleVoiceFrame = useCallback(
    (frame: LiveVoiceServerFrame) => {
      switch (frame.type) {
        case "ready":
          if (terminalTimerRef.current) {
            clearTimeout(terminalTimerRef.current);
            terminalTimerRef.current = null;
          }
          serverSessionOpenRef.current = true;
          appendSystemStatus("Voice link ready.");
          setMode("listening");
          break;
        case "busy":
          appendTranscript({
            id: cryptoId(),
            role: "system",
            text: "Voice is still finishing the previous turn. Resetting the voice link; try again.",
            state: "final",
          });
          setConversationState(false);
          closeLiveVoiceSession();
          setMode("idle");
          break;
        case "stt_partial":
          if (typeof frame.text === "string") {
            const id = ensurePartial(partialIdsRef, "user");
            const ts = Date.now();
            setTranscript((prev) =>
              upsertPartial(prev, id, "user", frame.text!, ts),
            );
          }
          break;
        case "stt_final":
          if (typeof frame.text === "string" && frame.text.trim().length > 0) {
            const id = partialIdsRef.current.user ?? cryptoId();
            partialIdsRef.current.user = null;
            const ts = Date.now();
            setTranscript((prev) =>
              upsertPartial(prev, id, "user", frame.text!, ts, "final"),
            );
            appendSystemStatus(`Transcribed: ${frame.text}`);
          } else {
            partialIdsRef.current.user = null;
            appendSystemStatus("No speech was transcribed.");
          }
          setMode("thinking");
          break;
        case "thinking":
          appendSystemStatus("Voice turn sent to Eli.");
          setMode("thinking");
          break;
        case "assistant_text_delta": {
          if (typeof frame.text !== "string") break;
          assistantSpeechBufferRef.current += frame.text;
          const id = ensurePartial(partialIdsRef, "assistant");
          const ts = Date.now();
          setTranscript((prev) =>
            upsertPartial(prev, id, "assistant", frame.text!, ts, "partial", true),
          );
          setMode("speaking");
          break;
        }
        case "tts_audio":
          serverTtsAudioReceivedRef.current = true;
          if (
            typeof frame.dataBase64 === "string" &&
            typeof frame.mimeType === "string" &&
            typeof frame.sampleRate === "number"
          ) {
            ensurePlayback(ttsRef).enqueue({
              dataBase64: frame.dataBase64,
              mimeType: frame.mimeType,
              sampleRate: frame.sampleRate,
            });
          }
          break;
        case "tts_done":
          if (
            !serverTtsAudioReceivedRef.current &&
            assistantSpeechBufferRef.current.trim().length > 0
          ) {
            speakLocally(assistantSpeechBufferRef.current);
          }
          assistantSpeechBufferRef.current = "";
          serverTtsAudioReceivedRef.current = false;
          ttsFailureNotifiedRef.current = false;
          appendSystemStatus("Voice turn complete.");
          closeLiveVoiceSession();
          if (
            conversationActiveRef.current &&
            lastTurnHeardSpeechRef.current
          ) {
            scheduleConversationRelisten();
          } else {
            setConversationState(false);
            setMode("idle");
          }
          break;
        case "error":
          if (
            typeof frame.message === "string" &&
            frame.message.startsWith("Live voice TTS failed:")
          ) {
            if (!ttsFailureNotifiedRef.current) {
              ttsFailureNotifiedRef.current = true;
              appendSystemStatus(
                `Server voice unavailable; using macOS ${LOCAL_TTS_VOICE}.`,
              );
            }
            break;
          }
          appendTranscript({
            id: cryptoId(),
            role: "system",
            text: frame.message ?? "Live voice error",
            state: "final",
          });
          setConnectionStatus((prev) => ({
            ...prev,
            lastError: frame.message ?? "Live voice error",
          }));
          setConversationState(false);
          closeLiveVoiceSession();
          setMode("idle");
          break;
        case "closed":
          setConversationState(false);
          closeLiveVoiceSession();
          appendSystemStatus("Voice session closed.");
          setMode("idle");
          break;
        default:
          break;
      }
    },
    [
      appendSystemStatus,
      appendTranscript,
      closeLiveVoiceSession,
      scheduleConversationRelisten,
      setConversationState,
    ],
  );

  const startSession = useCallback(async (): Promise<void> => {
    if (!connection) {
      setConnectionStatus((prev) => ({
        ...prev,
        lastError: "Assistant connection is offline.",
      }));
      appendTranscript({
        id: cryptoId(),
        role: "system",
        text: "Assistant connection is offline. Start Eli with `vellum wake` and try again.",
        state: "final",
      });
      return;
    }
    if (startingSessionRef.current) return;
    if (sessionActiveRef.current || serverSessionOpenRef.current) return;
    startingSessionRef.current = true;
    try {
      if (!liveVoiceRef.current) {
        const client: LiveVoiceClient = new LiveVoiceClient(connection, {
          sampleRate: 16_000,
          onFrame: handleVoiceFrame,
          onClose: () => {
            if (liveVoiceRef.current === client) {
              liveVoiceRef.current = null;
            }
            sessionActiveRef.current = false;
            serverSessionOpenRef.current = false;
            clearVoiceTimers();
            appendSystemStatus("Voice socket closed.");
            setMode("idle");
          },
          onError: (err) =>
            setConnectionStatus((prev) => ({ ...prev, lastError: errorMessage(err) })),
        });
        liveVoiceRef.current = client;
        try {
          await client.open();
        } catch (err) {
          if (liveVoiceRef.current === client) {
            liveVoiceRef.current = null;
          }
          client.close();
          throw err;
        }
      }
      liveVoiceRef.current.start();
      sessionActiveRef.current = true;
      releaseSentRef.current = false;
      utteranceStartedAtRef.current = Date.now();
      sentAudioFramesRef.current = 0;
      heardSpeechRef.current = false;
      assistantSpeechBufferRef.current = "";
      serverTtsAudioReceivedRef.current = false;
      ttsFailureNotifiedRef.current = false;
      if (turnStartTimerRef.current) {
        clearTimeout(turnStartTimerRef.current);
      }
      // Hard-stop long utterances even when ambient noise keeps RMS above the
      // silence threshold. Without this cap, noisy rooms can keep capture open
      // for several extra seconds before the turn is sent upstream.
      turnStartTimerRef.current = setTimeout(() => {
        if (!sessionActiveRef.current || releaseSentRef.current) return;
        sessionActiveRef.current = false;
        releaseSentRef.current = true;
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        if (turnStartTimerRef.current) {
          clearTimeout(turnStartTimerRef.current);
          turnStartTimerRef.current = null;
        }
        lastTurnHeardSpeechRef.current = heardSpeechRef.current;
        if (!heardSpeechRef.current && conversationActiveRef.current) {
          setConversationState(false);
        }
        appendSystemStatus("Stopping voice capture at utterance limit.");
        liveVoiceRef.current?.pttRelease();
        armTerminalWatchdog();
        setMode("thinking");
      }, voiceConfig.vad.maxUtteranceMs);
      setMode("listening");
    } finally {
      startingSessionRef.current = false;
    }
  }, [
    armTerminalWatchdog,
    appendSystemStatus,
    clearVoiceTimers,
    connection,
    handleVoiceFrame,
    setConversationState,
    voiceConfig.vad.maxUtteranceMs,
  ]);

  function scheduleConversationRelisten(): void {
    if (relistenTimerRef.current) {
      clearTimeout(relistenTimerRef.current);
    }
    relistenTimerRef.current = setTimeout(() => {
      relistenTimerRef.current = null;
      if (
        !conversationActiveRef.current ||
        serverSessionOpenRef.current ||
        sessionActiveRef.current
      ) {
        return;
      }
      void startSession().catch((err) => {
        const message = errorMessage(err);
        setConnectionStatus((prev) => ({ ...prev, lastError: message }));
        appendTranscript({
          id: cryptoId(),
          role: "system",
          text: `Failed to restart listening: ${message}`,
          state: "final",
        });
        setConversationState(false);
        setMode("idle");
      });
    }, 150);
  }

  const endSession = useCallback((): void => {
    if (!sessionActiveRef.current || releaseSentRef.current) return;
    const elapsedMs = Date.now() - utteranceStartedAtRef.current;
    if (elapsedMs < voiceConfig.vad.minUtteranceMs) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        endSession();
      }, voiceConfig.vad.minUtteranceMs - elapsedMs);
      return;
    }
    sessionActiveRef.current = false;
    releaseSentRef.current = true;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (turnStartTimerRef.current) {
      clearTimeout(turnStartTimerRef.current);
      turnStartTimerRef.current = null;
    }
    if (!heardSpeechRef.current) {
      if (conversationActiveRef.current) {
        setConversationState(false);
      }
      appendSystemStatus("Stopping voice capture; no clear speech detected.");
    } else {
      appendSystemStatus(
        `Stopping voice capture after ${sentAudioFramesRef.current} audio frames.`,
      );
    }
    lastTurnHeardSpeechRef.current = heardSpeechRef.current;
    liveVoiceRef.current?.pttRelease();
    armTerminalWatchdog();
    setMode("thinking");
  }, [
    appendSystemStatus,
    armTerminalWatchdog,
    setConversationState,
    voiceConfig.vad.minUtteranceMs,
  ]);

  const armSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      endSession();
    }, voiceConfig.vad.silenceMs);
  }, [endSession, voiceConfig.vad.silenceMs]);

  const handleMicFrame = useCallback(
    async (samples: Int16Array, rms: number) => {
      if (rms > MIN_SPEECH_RMS && sessionActiveRef.current) {
        heardSpeechRef.current = true;
        if (mode === "speaking") {
          ttsRef.current?.stop();
          liveVoiceRef.current?.interrupt();
        }
        armSilenceTimer();
      }

      if (sessionActiveRef.current) {
        sentAudioFramesRef.current += 1;
        liveVoiceRef.current?.sendAudio(samples);
        return;
      }

      if (voiceConfig.alwaysOn) {
        // Track a rolling ambient baseline while idle, then derive a
        // dynamic wake threshold from that floor. This adapts to quiet
        // USB mics and noisy laptop mics without requiring users to shout.
        const boundedRms = Math.min(rms, 0.03);
        ambientNoiseRmsRef.current =
          ambientNoiseRmsRef.current * (1 - SPEECH_WAKE_NOISE_ALPHA) +
          boundedRms * SPEECH_WAKE_NOISE_ALPHA;
        const adaptiveThreshold = Math.max(
          SPEECH_WAKE_MIN_TRIGGER_RMS,
          Math.min(
            SPEECH_WAKE_MAX_TRIGGER_RMS,
            ambientNoiseRmsRef.current * SPEECH_WAKE_NOISE_MULTIPLIER,
          ),
        );
        wakeThresholdRmsRef.current = adaptiveThreshold;
        setWakeThresholdRms((prev) =>
          Math.abs(prev - adaptiveThreshold) >= WAKE_THRESHOLD_UI_EPSILON
            ? adaptiveThreshold
            : prev,
        );

        if (Date.now() >= speechWakeCooldownUntilRef.current) {
          if (rms >= wakeThresholdRmsRef.current) {
            speechWakeFramesRef.current += 1;
          } else {
            speechWakeFramesRef.current = Math.max(
              0,
              speechWakeFramesRef.current - 1,
            );
          }
          if (
            speechWakeFramesRef.current >= SPEECH_WAKE_TRIGGER_FRAMES &&
            !startingSessionRef.current
          ) {
            speechWakeFramesRef.current = 0;
            speechWakeCooldownUntilRef.current = Date.now() + SPEECH_WAKE_COOLDOWN_MS;
            setConversationState(true);
            appendSystemStatus("Voice activity wake.");
            void startSession().catch((err) => {
              const message = errorMessage(err);
              setConnectionStatus((prev) => ({ ...prev, lastError: message }));
              appendTranscript({
                id: cryptoId(),
                role: "system",
                text: `Failed to start listening from voice activity: ${message}`,
                state: "final",
              });
              setConversationState(false);
              setMode("idle");
            });
            return;
          }
        }
      } else {
        speechWakeFramesRef.current = 0;
      }
    },
    [
      appendSystemStatus,
      appendTranscript,
      armSilenceTimer,
      mode,
      setConversationState,
      startSession,
      voiceConfig.alwaysOn,
    ],
  );

  // Keep the ref pointing at the latest handleMicFrame so the mic
  // closure below can call the current callback without triggering a
  // mic restart whenever its identity changes.
  useEffect(() => {
    handleMicFrameRef.current = handleMicFrame;
  }, [handleMicFrame]);

  // Mic / wake-word lifecycle. Deliberately depends only on `connection`
  // (and the static voice-config flags) so the AudioContext + mediaStream
  // are created exactly once per assistant connection.
  useEffect(() => {
    if (!connection) return;

    const mic = new MicStream({
      onFrame: (frame) => {
        let rms = 0;
        for (let i = 0; i < frame.length; i += 1) {
          rms += frame[i]! * frame[i]!;
        }
        rms = Math.sqrt(rms / Math.max(1, frame.length)) / 0x8000;
        handleMicFrameRef.current?.(frame, rms);
      },
      onAmplitude: (amp) => setAmplitude(amp),
      onError: (err) =>
        setConnectionStatus((prev) => ({ ...prev, lastError: errorMessage(err) })),
    });
    micRef.current = mic;

    // The HUD's wake mechanism is the RMS-based voice-activity detector
    // implemented inside `handleMicFrame`. We deliberately do NOT use
    // `webkitSpeechRecognition` for keyword spotting: in an unsigned
    // `tauri dev` binary the WebView's call into Apple's on-device
    // `SFSpeechRecognizer` triggers macOS TCC enforcement, and because
    // the dev binary has no stable code-signed identity TCC kills the
    // process with `EXC_CRASH/SIGABRT` regardless of what usage
    // descriptions are in the embedded Info.plist. The RMS path is
    // permission-free, on-device, and good enough to open a turn so the
    // user can say "Eli, …" and have the server-side STT do the rest.
    //
    // If/when we ship a properly bundled + code-signed `.app`, a
    // keyword-aware wake (Apple Speech, Picovoice, or a small local
    // model) can be reintroduced — but it MUST live behind a check that
    // verifies the host process is code-signed, otherwise dev/preview
    // builds will crash on first launch.
    const armWakeFromConfig =
      Boolean(voiceConfig.alwaysOn) &&
      Boolean(voiceConfig.wakeWord.enabled) &&
      Boolean(voiceConfig.wakeWord.runOnClient);
    setWakeWordActive(armWakeFromConfig);
    ambientNoiseRmsRef.current = 0.004;
    wakeThresholdRmsRef.current = SPEECH_WAKE_MIN_TRIGGER_RMS;
    setWakeThresholdRms(SPEECH_WAKE_MIN_TRIGGER_RMS);
    if (armWakeFromConfig) {
      appendSystemStatus("Voice-activity wake armed — start speaking to open a turn.");
    }

    void mic
      .start()
      .then(() => {
        appendSystemStatus(`Mic capture started (${mic.sampleRate} Hz mono).`);
      })
      .catch((err) => {
        const message = errorMessage(err);
        setConnectionStatus((prev) => ({
          ...prev,
          lastError: `Mic unavailable: ${message}`,
        }));
        appendTranscript({
          id: cryptoId(),
          role: "system",
          text: `Mic unavailable: ${message}. Grant Microphone permission for Eli HUD in System Settings > Privacy & Security > Microphone, then restart the app.`,
          state: "final",
        });
      });

    return () => {
      void mic.stop();
      setWakeWordActive(false);
      speechWakeFramesRef.current = 0;
      speechWakeCooldownUntilRef.current = 0;
      wakeThresholdRmsRef.current = SPEECH_WAKE_MIN_TRIGGER_RMS;
      micRef.current = null;
    };
  }, [
    appendSystemStatus,
    appendTranscript,
    connection,
    voiceConfig.alwaysOn,
    voiceConfig.wakeWord.enabled,
    voiceConfig.wakeWord.runOnClient,
  ]);

  // Keep modeRef in sync with `mode` so async callbacks (mic frame,
  // playback handlers) can read the current mode without re-creating
  // their closures on every render.
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Tear down live-voice + TTS on unmount.
  useEffect(() => {
    return () => {
      clearVoiceTimers();
      liveVoiceRef.current?.close();
      void ttsRef.current?.stop();
    };
  }, [clearVoiceTimers]);

  const toggleListening = useCallback(async (): Promise<void> => {
    if (!connection) {
      setConnectionStatus((prev) => ({
        ...prev,
        lastError: "Assistant connection is offline.",
      }));
      appendTranscript({
        id: cryptoId(),
        role: "system",
        text: "Assistant connection is offline. Start Eli with `vellum wake` and try again.",
        state: "final",
      });
      return;
    }
    // Treat every toggle click as a user gesture for the AudioContext.
    // WebKit suspends the context when the window loses focus, and a
    // suspended context silently drops onaudioprocess callbacks — that
    // was the smoking gun behind the "no audio chunks reach the server"
    // bug. Calling resume() here costs nothing when the context is
    // already running.
    await micRef.current?.ensureResumed();

    if (startingSessionRef.current) {
      // Another start is in flight — ignore this click instead of letting
      // it cancel itself on the next condition. The UI was getting stuck
      // because two fast clicks during the WS-open window would set
      // conversationActive=true, then immediately tear the new session
      // down.
      return;
    }
    if (sessionActiveRef.current) {
      endSession();
      return;
    }
    if (serverSessionOpenRef.current) {
      appendSystemStatus("Resetting the previous voice turn.");
      setConversationState(false);
      closeLiveVoiceSession();
      setMode("idle");
      return;
    }
    if (conversationActiveRef.current) {
      setConversationState(false);
      appendSystemStatus("Conversation standby.");
      setMode("idle");
      return;
    }
    try {
      setConversationState(true);
      await startSession();
    } catch (err) {
      const message = errorMessage(err);
      setConnectionStatus((prev) => ({ ...prev, lastError: message }));
      appendTranscript({
        id: cryptoId(),
        role: "system",
        text: `Failed to start listening: ${message}`,
        state: "final",
      });
      setConversationState(false);
    }
  }, [
    appendSystemStatus,
    appendTranscript,
    closeLiveVoiceSession,
    connection,
    endSession,
    setConversationState,
    startSession,
  ]);

  const cancelTts = useCallback((): void => {
    void ttsRef.current?.stop();
    void invoke("stop_speech").catch(() => undefined);
    liveVoiceRef.current?.interrupt();
    setMode(sessionActiveRef.current ? "listening" : "idle");
  }, []);

  const sendText = useCallback(
    async (text: string): Promise<void> => {
      if (!gatewayClient || text.trim().length === 0) return;
      const id = cryptoId();
      appendTranscript({
        id,
        role: "user",
        text,
        state: "final",
      });
      try {
        await gatewayClient.sendMessage({ content: text, clientMessageId: id });
        setMode("thinking");
      } catch (err) {
        setConnectionStatus((prev) => ({
          ...prev,
          lastError: errorMessage(err),
        }));
      }
    },
    [appendTranscript, gatewayClient],
  );

  // Periodically prune very old entries.
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - ENTRY_TTL_MS;
      setTranscript((prev) => prev.filter((entry) => entry.timestamp > cutoff));
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  return {
    mode,
    amplitude,
    conversationActive,
    wakeWordActive,
    wakeThresholdRms,
    transcript,
    activePlan,
    connection: connectionStatus,
    sendText,
    toggleListening,
    cancelTts,
  };
}

interface IngestContext {
  updateTranscript: (id: string, mutation: (current: TranscriptEntry) => TranscriptEntry) => void;
  setTranscript: React.Dispatch<React.SetStateAction<readonly TranscriptEntry[]>>;
  setActivePlan: React.Dispatch<React.SetStateAction<ActivePlanStatus | null>>;
  partialIdsRef: React.MutableRefObject<{ user: string | null; assistant: string | null }>;
  setConnectionStatus: React.Dispatch<React.SetStateAction<ConnectionStatus>>;
  setMode: React.Dispatch<React.SetStateAction<AssistantMode>>;
  sessionActiveRef: React.MutableRefObject<boolean>;
}

function ingestEvent(event: GatewayEventEnvelope, ctx: IngestContext): void {
  // The gateway streams flat ServerMessage objects, but older upstreams
  // (and some test fixtures) wrap them in `{ message: { ... } }`. Accept
  // both shapes by unwrapping when the envelope is present.
  const message: GatewayServerMessage =
    event.message ?? (event as GatewayServerMessage);
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "assistant_text_delta": {
      const text = typeof message.delta === "string" ? message.delta : message.text;
      if (typeof text !== "string") return;
      const id = ensurePartial(ctx.partialIdsRef, "assistant");
      const ts = Date.now();
      ctx.setTranscript((prev) =>
        upsertPartial(prev, id, "assistant", text, ts, "partial", true),
      );
      ctx.setMode("speaking");
      break;
    }
    case "assistant_message_complete":
    case "assistant_text_complete":
    case "message_complete": {
      const id = ctx.partialIdsRef.current.assistant;
      if (id) {
        ctx.updateTranscript(id, (current) => ({
          ...current,
          state: "final",
        }));
      }
      ctx.partialIdsRef.current.assistant = null;
      ctx.setMode(ctx.sessionActiveRef.current ? "listening" : "idle");
      break;
    }
    case "user_message":
    case "user_message_echo": {
      if (typeof message.text === "string") {
        const id =
          typeof message.clientMessageId === "string"
            ? message.clientMessageId
            : typeof message.messageId === "string"
              ? message.messageId
              : cryptoId();
        ctx.setTranscript((prev) =>
          upsertPartial(prev, id, "user", message.text!, Date.now(), "final"),
        );
      }
      break;
    }
    case "conversation_error": {
      const text =
        message.userMessage ??
        message.error ??
        (typeof message.debugDetails === "string"
          ? message.debugDetails
          : "The assistant hit an error while responding.");
      ctx.setConnectionStatus((prev) => ({
        ...prev,
        lastError: text,
      }));
      ctx.setTranscript((prev) =>
        [
          ...prev,
          {
            id: cryptoId(),
            role: "system" as const,
            text,
            state: "final" as const,
            timestamp: Date.now(),
          },
        ].slice(-MAX_TRANSCRIPT_ENTRIES),
      );
      break;
    }
    case "model_changed": {
      if (typeof message.content === "string") {
        ctx.setConnectionStatus((prev) => ({
          ...prev,
          model: message.content as string,
        }));
      }
      break;
    }
    case "plan_lifecycle": {
      if (typeof message.planId !== "string" || typeof message.goal !== "string") {
        break;
      }
      ctx.setActivePlan((prev) => {
        const samePlan = prev !== null && prev.planId === message.planId;
        return {
          planId: message.planId as string,
          goal: message.goal as string,
          stage: typeof message.stage === "string" ? message.stage : "running",
          stepName: samePlan ? prev.stepName : null,
          stepStage: samePlan ? prev.stepStage : null,
          updatedAt: typeof message.ts === "number" ? message.ts : Date.now(),
          message: typeof message.message === "string" ? message.message : null,
        };
      });
      break;
    }
    case "plan_step_lifecycle": {
      if (
        typeof message.planId !== "string" ||
        typeof message.stepName !== "string"
      ) {
        break;
      }
      ctx.setActivePlan((prev) => {
        const samePlan = prev !== null && prev.planId === message.planId;
        return {
          planId: message.planId as string,
          goal: samePlan ? prev.goal : "Active plan",
          stage: samePlan ? prev.stage : "running",
          stepName: message.stepName as string,
          stepStage:
            typeof message.stage === "string" ? message.stage : "executing",
          updatedAt: typeof message.ts === "number" ? message.ts : Date.now(),
          message: typeof message.message === "string" ? message.message : null,
        };
      });
      break;
    }
    default:
      break;
  }
}

function speakLocally(text: string): void {
  const cleaned = text.trim();
  if (cleaned.length === 0) return;
  void invoke("speak_text", {
    text: cleaned,
    voice: LOCAL_TTS_VOICE,
  }).catch(() => undefined);
}

function ensurePartial(
  ref: React.MutableRefObject<{ user: string | null; assistant: string | null }>,
  role: "user" | "assistant",
): string {
  const current = ref.current[role];
  if (current) return current;
  const id = cryptoId();
  ref.current = { ...ref.current, [role]: id };
  return id;
}

function upsertPartial(
  prev: readonly TranscriptEntry[],
  id: string,
  role: TranscriptEntry["role"],
  text: string,
  timestamp: number,
  state: TranscriptEntry["state"] = "partial",
  append = false,
): TranscriptEntry[] {
  const next = [...prev];
  const idx = next.findIndex((entry) => entry.id === id);
  if (idx === -1) {
    next.push({ id, role, text, state, timestamp });
  } else {
    const existing = next[idx]!;
    next[idx] = {
      ...existing,
      text: append ? existing.text + text : text,
      state,
      timestamp,
    };
  }
  return next.slice(-MAX_TRANSCRIPT_ENTRIES);
}

function ensurePlayback(ref: React.MutableRefObject<TtsPlayback | null>): TtsPlayback {
  if (!ref.current) ref.current = new TtsPlayback();
  return ref.current;
}

function cryptoId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
