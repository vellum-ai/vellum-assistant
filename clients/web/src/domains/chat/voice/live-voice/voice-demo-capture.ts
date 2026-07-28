import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import {
  LIVE_VOICE_AUDIO_FORMAT,
} from "@/domains/chat/voice/live-voice/protocol";
import {
  type VoiceDemoAudioRoute,
  type VoiceDemoAudioSegment,
  type VoiceDemoEvent,
  type VoiceDemoFinalizerInput,
  type VoiceDemoFinalizerResult,
  type VoiceDemoSessionDocument,
  type VoiceDemoTranscriptEntry,
} from "@/domains/chat/voice/live-voice/voice-demo-finalizer";
import { isNativeIOS } from "@/runtime/platform-detection";

declare global {
  interface Window {
    __vellumVoiceDemoCaptureEnabled?: true;
  }
}

interface VoiceDemoCapturePlugin {
  getAudioRoute(): Promise<VoiceDemoAudioRoute>;
  exportCapture(options: {
    filename: string;
    dataBase64: string;
  }): Promise<{ url: string }>;
  addListener(
    eventName: "audioRouteChanged",
    listener: (route: VoiceDemoAudioRoute) => void,
  ): Promise<PluginListenerHandle>;
}

const NativeVoiceDemoCapture =
  registerPlugin<VoiceDemoCapturePlugin>("VoiceDemoCapture");

interface ScheduledAssistantBuffer {
  id: string;
  turnId: string | null;
  segment: VoiceDemoAudioSegment;
}

interface ActiveUtterance {
  id: string;
  startedT: number;
}

interface PendingUserTranscript {
  t: number;
  text: string;
}

const EMPTY_AUDIO_ROUTE: VoiceDemoAudioRoute = {
  inputs: [],
  outputs: [],
  sampleRate: 0,
  ioBufferDuration: 0,
};

export class VoiceDemoCaptureSession {
  private readonly sessionId = crypto.randomUUID();
  private readonly startedAt = new Date();
  private readonly origin = performance.now();
  private readonly events: VoiceDemoEvent[] = [];
  private readonly alexSegments: VoiceDemoAudioSegment[] = [];
  private readonly paxSegments: VoiceDemoAudioSegment[] = [];
  private readonly transcriptEntries: VoiceDemoTranscriptEntry[] = [];
  private readonly assistantTextByTurn = new Map<string, string>();
  private readonly assistantFirstTokenTurns = new Set<string>();
  private readonly chunkTurnIds = new Map<string, string | null>();
  private readonly scheduledAssistantBuffers = new Map<
    string,
    ScheduledAssistantBuffer
  >();

  private audioRoute = EMPTY_AUDIO_ROUTE;
  private routeListener: PluginListenerHandle | null = null;
  private activeUtterance: ActiveUtterance | null = null;
  private lastUserSpeechStartT: number | null = null;
  private pendingUserTranscript: PendingUserTranscript | null = null;
  private currentTurnId: string | null = null;
  private nextAlexT: number | null = null;
  private eventSequence = 0;
  private finalizePromise: Promise<void> | null = null;

  static startIfEnabled(): VoiceDemoCaptureSession | null {
    if (
      typeof window === "undefined" ||
      window.__vellumVoiceDemoCaptureEnabled !== true ||
      !isNativeIOS()
    ) {
      return null;
    }
    return new VoiceDemoCaptureSession();
  }

  private constructor() {
    this.recordEvent({ type: "capture_started" }, 0);
    this.initializeAudioRouteTracking();
  }

  get elapsedSeconds(): number {
    return Math.max(0, (performance.now() - this.origin) / 1000);
  }

  recordEvent(
    event: Omit<VoiceDemoEvent, "t"> & { t?: number },
    t = event.t ?? this.elapsedSeconds,
  ): void {
    if (this.finalizePromise) {
      return;
    }
    this.events.push({
      ...event,
      t: Math.max(0, t),
      metadata: {
        ...event.metadata,
        sequence: this.eventSequence++,
      },
    });
  }

  recordMicrophoneChunk(buffer: ArrayBuffer): void {
    if (this.finalizePromise || buffer.byteLength === 0) {
      return;
    }
    const copied = buffer.slice(0);
    const frameCount = copied.byteLength / Int16Array.BYTES_PER_ELEMENT;
    const duration = frameCount / LIVE_VOICE_AUDIO_FORMAT.sampleRate;
    const observedStart = Math.max(0, this.elapsedSeconds - duration);
    const startT = this.nextAlexT ?? observedStart;
    const endT = startT + duration;
    this.nextAlexT = endT;
    this.alexSegments.push({
      id: `alex-${this.alexSegments.length + 1}`,
      startT,
      endT,
      sampleRate: LIVE_VOICE_AUDIO_FORMAT.sampleRate,
      format: "int16",
      channels: [copied],
    });
  }

  recordUserSpeechStarted(id: string): void {
    if (this.activeUtterance) {
      return;
    }
    const startedT = this.elapsedSeconds;
    this.activeUtterance = { id, startedT };
    this.recordEvent({ type: "user_speech_started", id }, startedT);
  }

  recordUserSpeechEnded(id?: string): void {
    const utterance = this.activeUtterance;
    const endedT = this.elapsedSeconds;
    const utteranceId = id ?? utterance?.id;
    this.recordEvent(
      {
        type: "user_speech_ended",
        ...(utteranceId ? { id: utteranceId } : {}),
        ...(utterance ? { endT: endedT } : {}),
      },
      endedT,
    );
    if (utterance) {
      this.lastUserSpeechStartT = utterance.startedT;
    }
    this.activeUtterance = null;
  }

  recordUserTranscriptPartial(text: string): void {
    this.recordEvent({ type: "user_transcript_partial", text });
  }

  recordUserTranscriptFinal(text: string): void {
    const t = this.elapsedSeconds;
    const utteranceT =
      this.activeUtterance?.startedT ?? this.lastUserSpeechStartT ?? t;
    this.pendingUserTranscript = { t: utteranceT, text };
    this.recordEvent({
      type: "user_transcript_final",
      text,
      metadata: { speechStartT: utteranceT },
    });
  }

  recordRequestStarted(turnId: string): void {
    this.currentTurnId = turnId;
    this.recordEvent({ type: "request_started", id: turnId });
    const pending = this.pendingUserTranscript;
    if (pending && pending.text.trim().length > 0) {
      this.transcriptEntries.push({
        t: pending.t,
        speaker: "ALEX",
        text: pending.text,
      });
      this.pendingUserTranscript = null;
      this.lastUserSpeechStartT = null;
    }
  }

  recordAssistantTextDelta(turnId: string, text: string): void {
    if (!this.assistantFirstTokenTurns.has(turnId)) {
      this.assistantFirstTokenTurns.add(turnId);
      this.recordEvent({
        type: "assistant_first_token",
        id: turnId,
        text,
      });
    }
    this.assistantTextByTurn.set(
      turnId,
      `${this.assistantTextByTurn.get(turnId) ?? ""}${text}`,
    );
    this.recordEvent({
      type: "assistant_text_delta",
      id: turnId,
      text,
    });
  }

  recordAssistantTextFinal(turnId: string): void {
    const text = this.assistantTextByTurn.get(turnId) ?? "";
    const playbackStartT = this.earliestPlaybackStart(turnId);
    this.recordEvent({
      type: "assistant_text_final",
      id: turnId,
      text,
      ...(playbackStartT === null
        ? {}
        : { metadata: { playbackStartT } }),
    });
    if (text.trim().length > 0) {
      this.transcriptEntries.push({
        t: playbackStartT ?? this.elapsedSeconds,
        speaker: "PAX",
        text,
      });
    }
  }

  recordTtsChunkReceived(options: {
    id: string;
    turnId?: string | null;
    sampleRate: number;
    mimeType: string;
    byteLength: number;
  }): void {
    const turnId = options.turnId ?? this.currentTurnId;
    this.chunkTurnIds.set(options.id, turnId);
    this.recordEvent({
      type: "tts_chunk_received",
      id: options.id,
      metadata: {
        turnId,
        sampleRate: options.sampleRate,
        mimeType: options.mimeType,
        byteLength: options.byteLength,
      },
    });
  }

  recordAssistantBufferScheduled(options: {
    id: string;
    buffer: AudioBuffer;
    delaySeconds: number;
  }): void {
    if (this.finalizePromise) {
      return;
    }
    const startT = Math.max(0, this.elapsedSeconds + options.delaySeconds);
    const endT = startT + options.buffer.duration;
    const channels: ArrayBuffer[] = [];
    for (
      let channelIndex = 0;
      channelIndex < options.buffer.numberOfChannels;
      channelIndex++
    ) {
      channels.push(options.buffer.getChannelData(channelIndex).slice().buffer);
    }
    const turnId = this.chunkTurnIds.get(options.id) ?? this.currentTurnId;
    const segment: VoiceDemoAudioSegment = {
      id: options.id,
      startT,
      endT,
      sampleRate: options.buffer.sampleRate,
      format: "float32",
      channels,
    };
    this.paxSegments.push(segment);
    this.scheduledAssistantBuffers.set(options.id, {
      id: options.id,
      turnId,
      segment,
    });
    const metadata = {
      turnId,
      scheduledPlaybackT: startT,
      frameCount: options.buffer.length,
      sampleRate: options.buffer.sampleRate,
      channelCount: options.buffer.numberOfChannels,
      durationSeconds: options.buffer.duration,
      playbackState: "scheduled",
    };
    this.recordEvent({
      type: "assistant_audio_scheduled",
      id: options.id,
      metadata,
    });
    this.recordEvent(
      {
        type: "assistant_audio_started",
        id: options.id,
        metadata: { ...metadata, playbackState: "started" },
      },
      startT,
    );
  }

  recordAssistantBufferEnded(options: {
    id: string;
    state: "completed" | "cancelled";
    delaySeconds: number;
  }): void {
    const scheduled = this.scheduledAssistantBuffers.get(options.id);
    if (!scheduled) {
      return;
    }
    const observedT = Math.max(0, this.elapsedSeconds + options.delaySeconds);
    const endT =
      options.state === "completed"
        ? scheduled.segment.endT
        : Math.max(
            scheduled.segment.startT,
            Math.min(scheduled.segment.endT, observedT),
          );
    scheduled.segment.endT = endT;
    this.recordEvent(
      {
        type: "assistant_audio_ended",
        id: options.id,
        endT,
        metadata: {
          turnId: scheduled.turnId,
          playbackState: options.state,
        },
      },
      endT,
    );
    this.scheduledAssistantBuffers.delete(options.id);
  }

  recordInterruptionStarted(id?: string): void {
    this.recordEvent({
      type: "interruption_started",
      ...(id ? { id } : {}),
    });
  }

  recordInterruptionEnded(id?: string): void {
    this.recordEvent({
      type: "interruption_ended",
      ...(id ? { id } : {}),
    });
  }

  recordCaptureError(error: unknown, phase: string): void {
    const message =
      error instanceof Error ? error.message : "Voice demo capture failed";
    this.recordEvent({
      type: "capture_error",
      text: message,
      metadata: { phase },
    });
    console.warn(`[voice-demo-capture] ${phase}: ${message}`);
  }

  finalizeAndExport(): Promise<void> {
    if (this.finalizePromise) {
      return this.finalizePromise;
    }
    this.finalizePromise = this.performFinalization();
    return this.finalizePromise;
  }

  private async performFinalization(): Promise<void> {
    const durationSeconds = this.elapsedSeconds;
    if (this.activeUtterance) {
      this.events.push({
        type: "user_speech_ended",
        id: this.activeUtterance.id,
        t: durationSeconds,
        endT: durationSeconds,
        metadata: { sequence: this.eventSequence++ },
      });
      this.activeUtterance = null;
    }
    this.events.push({
      type: "capture_stopped",
      t: durationSeconds,
      metadata: { sequence: this.eventSequence++ },
    });
    for (const scheduled of this.scheduledAssistantBuffers.values()) {
      scheduled.segment.endT = Math.max(
        scheduled.segment.startT,
        Math.min(scheduled.segment.endT, durationSeconds),
      );
    }
    if (
      this.pendingUserTranscript &&
      this.pendingUserTranscript.text.trim().length > 0
    ) {
      this.transcriptEntries.push({
        t: this.pendingUserTranscript.t,
        speaker: "ALEX",
        text: this.pendingUserTranscript.text,
      });
    }

    const routeListener = this.routeListener;
    this.routeListener = null;
    if (routeListener) {
      await routeListener.remove().catch(() => {});
    }

    const timestamp = this.startedAt.toISOString().replaceAll(":", "-");
    const folderName = `voice-demo-${timestamp}`;
    const session: VoiceDemoSessionDocument = {
      sessionId: this.sessionId,
      startedAt: this.startedAt.toISOString(),
      durationSeconds,
      audioRoute: this.audioRoute,
      files: {
        alex: "alex.wav",
        pax: "pax.wav",
        mix: "mix.wav",
      },
      events: this.events.toSorted(
        (left, right) =>
          left.t - right.t ||
          eventSequence(left) - eventSequence(right),
      ),
    };
    const input: VoiceDemoFinalizerInput = {
      folderName,
      session,
      alexSegments: this.alexSegments,
      paxSegments: this.paxSegments,
      transcriptEntries: this.transcriptEntries,
    };

    try {
      const { filename, zip } = await runFinalizerWorker(input);
      const { url } = await NativeVoiceDemoCapture.exportCapture({
        filename,
        dataBase64: arrayBufferToBase64(zip),
      });
      console.info(`[voice-demo-capture] exported ${url}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Voice demo export failed";
      console.error(`[voice-demo-capture] export: ${message}`);
    }
  }

  private initializeAudioRouteTracking(): void {
    void NativeVoiceDemoCapture.addListener(
      "audioRouteChanged",
      (route) => {
        this.recordAudioRoute(route);
      },
    )
      .then((listener) => {
        if (this.finalizePromise) {
          void listener.remove();
          return;
        }
        this.routeListener = listener;
      })
      .catch((error: unknown) => {
        this.recordCaptureError(error, "audio_route_listener");
      });
    void NativeVoiceDemoCapture.getAudioRoute()
      .then((route) => {
        this.recordAudioRoute(route);
      })
      .catch((error: unknown) => {
        this.recordCaptureError(error, "audio_route");
      });
  }

  private recordAudioRoute(route: VoiceDemoAudioRoute): void {
    this.audioRoute = route;
    this.recordEvent({
      type: "audio_route",
      metadata: { ...route },
    });
  }

  private earliestPlaybackStart(turnId: string): number | null {
    let earliest: number | null = null;
    for (const scheduled of this.scheduledAssistantBuffers.values()) {
      if (scheduled.turnId !== turnId) {
        continue;
      }
      earliest =
        earliest === null
          ? scheduled.segment.startT
          : Math.min(earliest, scheduled.segment.startT);
    }
    for (const segment of this.paxSegments) {
      if (this.chunkTurnIds.get(segment.id) !== turnId) {
        continue;
      }
      earliest =
        earliest === null ? segment.startT : Math.min(earliest, segment.startT);
    }
    return earliest;
  }
}

function runFinalizerWorker(
  input: VoiceDemoFinalizerInput,
): Promise<Extract<VoiceDemoFinalizerResult, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./voice-demo-finalizer.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (event: MessageEvent<VoiceDemoFinalizerResult>) => {
      worker.terminate();
      if (event.data.ok) {
        resolve(event.data);
      } else {
        reject(new Error(event.data.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Voice demo finalizer worker failed"));
    };
    const transfer = [
      ...input.alexSegments.flatMap((segment) => segment.channels),
      ...input.paxSegments.flatMap((segment) => segment.channels),
    ];
    worker.postMessage(input, transfer);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function eventSequence(event: VoiceDemoEvent): number {
  const sequence = event.metadata?.sequence;
  return typeof sequence === "number" ? sequence : 0;
}
