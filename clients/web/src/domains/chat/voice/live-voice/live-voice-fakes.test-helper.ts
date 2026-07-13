/**
 * Hand-rolled fakes for the three live-voice primitives — client (transport),
 * capture (mic → PCM), player (TTS playback) — injected through
 * `useLiveVoice`'s factory options so tests touch no WebSocket, microphone,
 * or AudioContext. The fakes expose drivers (`emit`, `pushChunk`,
 * `pushAmplitude`, `finishPlayback`) so a test can drive a full turn and
 * assert state-machine transitions, barge-in, automatic ptt_release, and
 * teardown.
 *
 * Also exports the store-seeding helpers (`makeControlsSpies`,
 * `seedLiveVoiceSession`) shared by the surface tests that drive the real
 * `useLiveVoiceStore` directly (`chat-composer.test.tsx`,
 * `voice-session-pill-host.test.tsx`, `live-voice-store.test.ts`).
 *
 * Shared by `use-live-voice.test.ts` and
 * `use-live-voice-session-controller.test.tsx`. Imports from the primitives
 * stay type-only to keep the generated-SDK import graph out of test files
 * (the real client's `connection.ts` is mocked separately by each test); the
 * store is a value import, but it is self-contained zustand with no heavy
 * dependencies.
 */

import { mock } from "bun:test";

import type {
  LiveVoiceClientEventMap,
  LiveVoiceClientEventName,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import type {
  LiveVoiceAudioCaptureOptions,
  LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import {
  useLiveVoiceStore,
  type LiveVoiceSessionControls,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

export class FakeClient {
  connectArgs: {
    assistantId: string;
    conversationId?: string;
    turnDetection?: "manual" | "server_vad";
  } | null = null;
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
    turnDetection?: "manual" | "server_vad";
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
  /**
   * When true, `start()` stays pending until {@link resolveStart} — lets tests
   * hold the mic acquisition open across `ready`/teardown. Must be set before
   * `start()` is called (i.e. at creation, in the `createCapture` factory,
   * since the controller starts the capture at connect time).
   */
  deferStart = false;
  private startResolvers: Array<(result: LiveVoiceCaptureResult) => void> = [];

  constructor(options: LiveVoiceAudioCaptureOptions) {
    this.onChunk = options.onChunk;
    this.onAmplitude = options.onAmplitude;
  }

  async start(): Promise<LiveVoiceCaptureResult> {
    this.startCount++;
    if (this.deferStart) {
      return new Promise((resolve) => this.startResolvers.push(resolve));
    }
    return this.startResult;
  }
  async stop(): Promise<void> {
    this.stopCount++;
  }
  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }

  /** Resolve pending deferred `start()` calls with the current `startResult`. */
  resolveStart(): void {
    const resolvers = this.startResolvers;
    this.startResolvers = [];
    for (const resolve of resolvers) {
      resolve(this.startResult);
    }
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
  prewarmCount = 0;
  isPlaying = false;
  private drainResolvers: Array<() => void> = [];

  prewarm(): void {
    this.prewarmCount++;
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
    if (!this.isPlaying) {
      return;
    }
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
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

/** A PCM chunk of `ms` milliseconds at 16 kHz mono Int16. */
export function pcmChunk(ms: number): ArrayBuffer {
  const samples = Math.round((16000 * ms) / 1000);
  return new Int16Array(samples).buffer;
}

/** Spy implementations of the store-registered session controls. */
export function makeControlsSpies() {
  return {
    stop: mock(() => {}),
    release: mock(() => {}),
    interrupt: mock(() => {}),
    setMuted: mock((_muted: boolean) => {}),
  } satisfies LiveVoiceSessionControls;
}

/**
 * Seed the real `useLiveVoiceStore` with a session, mirroring the writes the
 * controller performs on `start()` (context → controls → state). Pass
 * `conversationId: null` for a draft-started session; omit `controls` to
 * leave none registered.
 */
export function seedLiveVoiceSession(
  state: LiveVoiceSessionState,
  options: {
    assistantId: string;
    conversationId: string | null;
    controls?: LiveVoiceSessionControls;
  },
): void {
  const store = useLiveVoiceStore.getState();
  store.setSessionContext(options.assistantId, options.conversationId);
  if (options.controls) {
    store.setControls(options.controls);
  }
  store.setState(state);
}
