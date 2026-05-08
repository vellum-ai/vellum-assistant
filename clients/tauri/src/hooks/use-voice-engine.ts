import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GatewayClient } from "../services/gateway-client.js";
import {
  type GatewayEventEnvelope,
  GatewayEventStream,
} from "../services/gateway-events.js";
import {
  LiveVoiceClient,
  type LiveVoiceServerFrame,
} from "../services/live-voice-client.js";
import { MicStream } from "../services/mic-stream.js";
import { TtsPlayback } from "../services/tts-playback.js";
import { WakeWordClient, type WakeWordKeyword } from "../services/wake-word-client.js";
import type {
  AssistantConnection,
  AssistantMode,
  ConnectionStatus,
  TranscriptEntry,
  VoiceConfigSnapshot,
} from "../types.js";

interface UseVoiceEngineOptions {
  readonly connection: AssistantConnection | null;
  readonly voiceConfig: VoiceConfigSnapshot;
  readonly picovoiceAccessKey: string | null;
}

interface VoiceEngineApi {
  readonly mode: AssistantMode;
  readonly amplitude: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly connection: ConnectionStatus;
  readonly sendText: (text: string) => Promise<void>;
  readonly toggleListening: () => Promise<void>;
  readonly cancelTts: () => void;
}

const ENTRY_TTL_MS = 5 * 60_000;
const MAX_TRANSCRIPT_ENTRIES = 80;

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
  const { connection, voiceConfig, picovoiceAccessKey } = options;

  const [mode, setMode] = useState<AssistantMode>(
    connection ? "idle" : "offline",
  );
  const [amplitude, setAmplitude] = useState(0);
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    model: null,
    latencyMs: null,
    lastError: null,
  });

  const micRef = useRef<MicStream | null>(null);
  const liveVoiceRef = useRef<LiveVoiceClient | null>(null);
  const wakeWordRef = useRef<WakeWordClient | null>(null);
  const ttsRef = useRef<TtsPlayback | null>(null);
  const eventStreamRef = useRef<GatewayEventStream | null>(null);
  const partialIdsRef = useRef<{ user: string | null; assistant: string | null }>({
    user: null,
    assistant: null,
  });
  const sessionActiveRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (!connection) {
      setMode("offline");
      return;
    }

    setMode("idle");
    const stream = new GatewayEventStream(connection, {
      onEvent: (event) => {
        ingestEvent(event, {
          appendTranscript,
          updateTranscript,
          partialIdsRef,
          setConnectionStatus,
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
  }, [appendTranscript, connection, updateTranscript]);

  const handleVoiceFrame = useCallback(
    (frame: LiveVoiceServerFrame) => {
      switch (frame.type) {
        case "ready":
          setMode("listening");
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
          if (typeof frame.text === "string") {
            const id = partialIdsRef.current.user ?? cryptoId();
            partialIdsRef.current.user = null;
            const ts = Date.now();
            setTranscript((prev) =>
              upsertPartial(prev, id, "user", frame.text!, ts, "final"),
            );
          }
          setMode("thinking");
          break;
        case "thinking":
          setMode("thinking");
          break;
        case "assistant_text_delta": {
          if (typeof frame.text !== "string") break;
          const id = ensurePartial(partialIdsRef, "assistant");
          const ts = Date.now();
          setTranscript((prev) =>
            upsertPartial(prev, id, "assistant", frame.text!, ts, "partial", true),
          );
          setMode("speaking");
          break;
        }
        case "tts_audio":
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
          setMode(sessionActiveRef.current ? "listening" : "idle");
          break;
        case "error":
          setConnectionStatus((prev) => ({
            ...prev,
            lastError: frame.message ?? "Live voice error",
          }));
          break;
        default:
          break;
      }
    },
    [],
  );

  const startSession = useCallback(async (): Promise<void> => {
    if (!connection) return;
    if (sessionActiveRef.current) return;

    if (!liveVoiceRef.current) {
      liveVoiceRef.current = new LiveVoiceClient(connection, {
        sampleRate: 16_000,
        onFrame: handleVoiceFrame,
        onClose: () => {
          sessionActiveRef.current = false;
          setMode("idle");
        },
        onError: (err) =>
          setConnectionStatus((prev) => ({ ...prev, lastError: errorMessage(err) })),
      });
      await liveVoiceRef.current.open();
    }
    liveVoiceRef.current.start();
    sessionActiveRef.current = true;
    setMode("listening");
  }, [connection, handleVoiceFrame]);

  const endSession = useCallback((): void => {
    sessionActiveRef.current = false;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (turnStartTimerRef.current) {
      clearTimeout(turnStartTimerRef.current);
      turnStartTimerRef.current = null;
    }
    liveVoiceRef.current?.pttRelease();
    setMode("thinking");
  }, []);

  const armSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      endSession();
    }, voiceConfig.vad.silenceMs);
  }, [endSession, voiceConfig.vad.silenceMs]);

  const handleMicFrame = useCallback(
    async (samples: Int16Array, rms: number) => {
      if (rms > 0.04 && sessionActiveRef.current) {
        if (mode === "speaking") {
          ttsRef.current?.stop();
          liveVoiceRef.current?.interrupt();
        }
        armSilenceTimer();
      }

      if (sessionActiveRef.current) {
        liveVoiceRef.current?.sendAudio(samples);
        return;
      }

      // Wake-word gating only runs when the session is closed and the
      // user has provisioned an access key. Without a key we silently
      // fall through to PTT-only mode.
      if (
        voiceConfig.alwaysOn &&
        voiceConfig.wakeWord.enabled &&
        wakeWordRef.current?.isActive()
      ) {
        await wakeWordRef.current.pushFrame(samples);
      }
    },
    [armSilenceTimer, mode, voiceConfig.alwaysOn, voiceConfig.wakeWord.enabled],
  );

  // Mic / wake-word lifecycle.
  useEffect(() => {
    if (!connection) return;

    const mic = new MicStream({
      onFrame: (frame) => {
        let rms = 0;
        for (let i = 0; i < frame.length; i += 1) {
          rms += frame[i]! * frame[i]!;
        }
        rms = Math.sqrt(rms / Math.max(1, frame.length)) / 0x8000;
        void handleMicFrame(frame, rms);
      },
      onAmplitude: (amp) => setAmplitude(amp),
      onError: (err) =>
        setConnectionStatus((prev) => ({ ...prev, lastError: errorMessage(err) })),
    });
    micRef.current = mic;

    const initWake = async (): Promise<void> => {
      if (
        voiceConfig.alwaysOn &&
        voiceConfig.wakeWord.enabled &&
        voiceConfig.wakeWord.runOnClient &&
        picovoiceAccessKey
      ) {
        const keywords: WakeWordKeyword[] = voiceConfig.wakeWord.keywords.map(
          (kw) => ({
            label: kw.label,
            sensitivity: 0.55,
            source: { kind: "builtin", keyword: kw.label },
          }),
        );
        const wake = new WakeWordClient({
          accessKey: picovoiceAccessKey,
          keywords,
          onWake: (label) => {
            appendTranscript({
              id: cryptoId(),
              role: "system",
              text: `Wake: ${label}`,
              state: "final",
            });
            void startSession();
          },
          onError: (err) =>
            setConnectionStatus((prev) => ({
              ...prev,
              lastError: errorMessage(err),
            })),
        });
        try {
          await wake.start();
          wakeWordRef.current = wake;
        } catch {
          wakeWordRef.current = null;
        }
      }
    };

    void mic.start().then(initWake).catch(() => undefined);

    return () => {
      void mic.stop();
      void wakeWordRef.current?.stop();
      wakeWordRef.current = null;
      micRef.current = null;
    };
  }, [
    appendTranscript,
    connection,
    handleMicFrame,
    picovoiceAccessKey,
    startSession,
    voiceConfig.alwaysOn,
    voiceConfig.wakeWord.enabled,
    voiceConfig.wakeWord.keywords,
    voiceConfig.wakeWord.runOnClient,
  ]);

  // Tear down live-voice + TTS on unmount.
  useEffect(() => {
    return () => {
      liveVoiceRef.current?.close();
      void ttsRef.current?.stop();
    };
  }, []);

  const toggleListening = useCallback(async (): Promise<void> => {
    if (!connection) return;
    if (sessionActiveRef.current) {
      endSession();
      return;
    }
    await startSession();
  }, [connection, endSession, startSession]);

  const cancelTts = useCallback((): void => {
    void ttsRef.current?.stop();
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
        await gatewayClient.sendMessage({ content: text });
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
    transcript,
    connection: connectionStatus,
    sendText,
    toggleListening,
    cancelTts,
  };
}

interface IngestContext {
  appendTranscript: (entry: Omit<TranscriptEntry, "timestamp"> & { timestamp?: number }) => void;
  updateTranscript: (id: string, mutation: (current: TranscriptEntry) => TranscriptEntry) => void;
  partialIdsRef: React.MutableRefObject<{ user: string | null; assistant: string | null }>;
  setConnectionStatus: React.Dispatch<React.SetStateAction<ConnectionStatus>>;
}

function ingestEvent(event: GatewayEventEnvelope, ctx: IngestContext): void {
  const message = event.message;
  if (!message) return;

  switch (message.type) {
    case "assistant_text_delta": {
      const text = typeof message.delta === "string" ? message.delta : message.text;
      if (typeof text !== "string") return;
      const id = ensurePartial(ctx.partialIdsRef, "assistant");
       
      ctx.updateTranscript(id, (current) => ({
        ...current,
        text: current.text + text,
        timestamp: Date.now(),
      }));
      break;
    }
    case "assistant_message_complete":
    case "assistant_text_complete": {
      const id = ctx.partialIdsRef.current.assistant;
      if (id) {
        ctx.updateTranscript(id, (current) => ({
          ...current,
          state: "final",
        }));
      }
      ctx.partialIdsRef.current.assistant = null;
      break;
    }
    case "user_message": {
      if (typeof message.text === "string") {
        ctx.appendTranscript({
          id: cryptoId(),
          role: "user",
          text: message.text,
          state: "final",
        });
      }
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
    default:
      break;
  }
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
