/**
 * Hand-rolled fakes for the three live-voice primitives — client, capture,
 * player — injected through `useLiveVoice`/`useVoiceMode` factory options so
 * tests never touch a WebSocket, microphone, or AudioContext. Each fake
 * exposes drivers (`emit`, `pushChunk`, `pushAmplitude`, `finishPlayback`)
 * so a test can puppet a full conversation turn.
 *
 * Shared by `use-live-voice.test.ts` and `use-voice-mode.test.ts`; not a
 * `.test.ts` file itself, so the test runner never collects it.
 */

import type {
  LiveVoiceClientEventMap,
  LiveVoiceClientEventName,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import type {
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";

export class FakeClient {
  connectArgs: { assistantId: string; conversationId?: string } | null = null;
  sentAudio: ArrayBuffer[] = [];
  pttReleaseCount = 0;
  interruptCount = 0;
  ended = false;
  closed = false;

  private handlers = new Map<
    LiveVoiceClientEventName,
    Set<(payload: never) => void>
  >();

  on<E extends LiveVoiceClientEventName>(
    event: E,
    handler: (payload: LiveVoiceClientEventMap[E]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set?.delete(handler as (payload: never) => void);
  }

  async connect(args: {
    assistantId: string;
    conversationId?: string;
  }): Promise<void> {
    this.connectArgs = args;
  }

  sendAudio(pcm: ArrayBuffer): void {
    this.sentAudio.push(pcm);
  }
  pttRelease(): void {
    this.pttReleaseCount++;
  }
  interrupt(): void {
    this.interruptCount++;
  }
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
  }

  /** Drive a server event to the controller's subscribed handlers. */
  emit<E extends LiveVoiceClientEventName>(
    event: E,
    payload: LiveVoiceClientEventMap[E],
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (payload: LiveVoiceClientEventMap[E]) => void)(payload);
    }
  }
}

export class FakeCapture {
  readonly onChunk: (buf: ArrayBuffer) => void;
  readonly onAmplitude?: (amplitude: number) => void;

  startCount = 0;
  stopCount = 0;
  shutdownCount = 0;
  startResult: LiveVoiceCaptureResult = { ok: true };

  constructor(options: LiveVoiceAudioCaptureOptions) {
    this.onChunk = options.onChunk;
    this.onAmplitude = options.onAmplitude;
  }

  async start(): Promise<LiveVoiceCaptureResult> {
    this.startCount++;
    return this.startResult;
  }
  async stop(): Promise<void> {
    this.stopCount++;
  }
  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }

  /** Feed a captured PCM chunk to the controller. */
  pushChunk(buf: ArrayBuffer): void {
    this.onChunk(buf);
  }
  /** Feed an amplitude reading to the controller. */
  pushAmplitude(amplitude: number): void {
    this.onAmplitude?.(amplitude);
  }
}

export class FakePlayer {
  enqueued: unknown[] = [];
  stopCount = 0;
  disposeCount = 0;
  isPlaying = false;
  volume: number | null = null;
  muted: boolean | null = null;
  private drainResolvers: Array<() => void> = [];

  setVolume(volume: number): void {
    this.volume = volume;
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  enqueue(chunk: unknown): void {
    this.enqueued.push(chunk);
    this.isPlaying = true;
  }
  stop(): void {
    this.stopCount++;
    this.isPlaying = false;
    this.resolveDrain();
  }
  async dispose(): Promise<void> {
    this.disposeCount++;
    this.stop();
  }
  async waitUntilDrained(): Promise<void> {
    if (!this.isPlaying) return;
    await new Promise<void>((resolve) => this.drainResolvers.push(resolve));
  }

  /** Simulate playback finishing naturally. */
  finishPlayback(): void {
    this.isPlaying = false;
    this.resolveDrain();
  }
  private resolveDrain(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/** A PCM chunk of `ms` milliseconds at 16 kHz mono Int16. */
export function pcmChunk(ms: number): ArrayBuffer {
  const samples = Math.round((16000 * ms) / 1000);
  return new Int16Array(samples).buffer;
}
