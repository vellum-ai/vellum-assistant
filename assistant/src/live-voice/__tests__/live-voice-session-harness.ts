/**
 * Shared fakes + harness for LiveVoiceSession composition-root tests.
 *
 * The fakes stand in for the session's three injected collaborators
 * (ingest, transport, controller) so session tests exercise only the
 * session's own responsibilities. Wired end-to-end coverage with the
 * real collaborators lives in live-voice-integration.test.ts.
 */

import { mock } from "bun:test";

import type { CallTransport } from "../../calls/call-transport.js";
import type { LiveVoiceAudioArchiveResult } from "../live-voice-archive.js";
import type {
  LiveVoiceIngestCallbacks,
  LiveVoiceIngestConfig,
} from "../live-voice-ingest.js";
import {
  LiveVoiceSession,
  type LiveVoiceSessionArchiveAudioInput,
  type LiveVoiceSessionControllerOptions,
  type LiveVoiceSessionOptions,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type { LiveVoiceCallTransportDeps } from "../live-voice-transport.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

export const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

export function createContext(
  startFrame: LiveVoiceClientStartFrame = START_FRAME,
): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];

  return {
    frames,
    context: {
      sessionId: "session-123",
      startFrame,
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    },
  };
}

// ── Collaborator fakes ────────────────────────────────────────────────

export class FakeIngest {
  config: LiveVoiceIngestConfig | null = null;
  callbacks: LiveVoiceIngestCallbacks = {};
  started = false;
  stopCount = 0;
  disposed = false;
  forceTurnEndCount = 0;
  readonly pushed: Buffer[] = [];

  start(): void {
    this.started = true;
  }

  pushAudio(chunk: Buffer): void {
    this.pushed.push(chunk);
  }

  forceTurnEnd(): void {
    this.forceTurnEndCount += 1;
  }

  stop(): void {
    this.stopCount += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeTransport implements CallTransport {
  deps: LiveVoiceCallTransportDeps | null = null;
  readonly tokens: Array<{ token: string; last: boolean }> = [];
  discardCount = 0;
  private assistantAudio: Buffer[] = [];

  sendTextToken(token: string, last: boolean): void {
    this.tokens.push({ token, last });
  }

  sendPlayUrl(): void {}

  endSession(reason?: string): void {
    this.deps?.onSessionEnd(reason);
  }

  setAudioStartCallback(): void {}

  discardPendingText(): void {
    this.discardCount += 1;
  }

  collectAssistantAudio(): Buffer[] {
    const chunks = this.assistantAudio;
    this.assistantAudio = [];
    return chunks;
  }

  /** Simulate a streaming-TTS audio chunk reaching the socket. */
  async emitTtsAudio(text: string, mimeType = "audio/pcm"): Promise<void> {
    this.assistantAudio.push(Buffer.from(text));
    await this.deps?.sendFrame({
      type: "tts_audio",
      mimeType,
      sampleRate: 24_000,
      dataBase64: Buffer.from(text).toString("base64"),
    });
  }

  /** Simulate the end-of-turn tts_done the TTS queue emits after draining. */
  async emitTtsDone(turnId = this.deps?.turnId() ?? ""): Promise<void> {
    await this.deps?.sendFrame({ type: "tts_done", turnId });
  }
}

export class FakeController {
  options: LiveVoiceSessionControllerOptions | null = null;
  state: "idle" | "processing" | "speaking" = "idle";
  readonly utterances: string[] = [];
  bargeInCount = 0;
  destroyed = false;

  async handleCallerUtterance(transcript: string): Promise<void> {
    this.utterances.push(transcript);
    this.state = "processing";
  }

  handleBargeIn(onAccepted?: () => void): boolean {
    if (this.state !== "speaking") {
      return false;
    }
    onAccepted?.();
    this.bargeInCount += 1;
    this.state = "idle";
    return true;
  }

  getState(): "idle" | "processing" | "speaking" {
    return this.state;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

// ── Harness ───────────────────────────────────────────────────────────

export interface SessionHarness {
  session: LiveVoiceSession;
  frames: LiveVoiceServerFrame[];
  ingest: FakeIngest;
  transport: FakeTransport;
  controller: FakeController;
  /** Controller-facing transport wrapper the session handed to the controller. */
  controllerTransport: () => CallTransport;
}

export function createSessionHarness(
  options: {
    startFrame?: LiveVoiceClientStartFrame;
    emitMetrics?: boolean;
    sessionOptions?: Partial<LiveVoiceSessionOptions>;
  } = {},
): SessionHarness {
  const { context, frames } = createContext(options.startFrame);
  const ingest = new FakeIngest();
  const transport = new FakeTransport();
  const controller = new FakeController();
  let turnCounter = 0;

  const session = new LiveVoiceSession(context, {
    createIngest: (config, callbacks) => {
      ingest.config = config;
      ingest.callbacks = callbacks;
      return ingest;
    },
    createTransport: (deps) => {
      transport.deps = deps;
      return transport;
    },
    createController: (controllerOptions) => {
      controller.options = controllerOptions;
      return controller;
    },
    credentialPreflight: async () => ({ status: "ready" }),
    archiveAudio: null,
    emitMetrics: options.emitMetrics ?? false,
    createTurnId: () => `live-turn-${++turnCounter}`,
    ...options.sessionOptions,
  });

  return {
    session,
    frames,
    ingest,
    transport,
    controller,
    controllerTransport: () => {
      const controllerTransport = controller.options?.transport;
      if (!controllerTransport) {
        throw new Error("Session has not created the controller yet");
      }
      return controllerTransport;
    },
  };
}

// ── Utilities ─────────────────────────────────────────────────────────

/** Successful archive result echoing the input's identity fields. */
export function makeArchiveResult(
  input: LiveVoiceSessionArchiveAudioInput,
): LiveVoiceAudioArchiveResult {
  const attachmentId = `${input.role}-attachment-123`;
  return {
    type: "archived",
    artifact: {
      source: "live-voice",
      archiveKey: `live-voice:${input.sessionId}:${input.turnId}:${input.role}`,
      attachmentId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: input.role,
      mimeType: input.mimeType,
      ...(input.sampleRate !== undefined
        ? { sampleRate: input.sampleRate }
        : {}),
      ...(input.durationMs !== undefined
        ? { durationMs: input.durationMs }
        : {}),
      sizeBytes: Buffer.byteLength(input.audio.dataBase64, "base64"),
      filename: `${attachmentId}.pcm`,
      archivedAt: 1_234,
    },
    idempotent: false,
  };
}

export async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice session condition",
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

export function frameTypes(frames: LiveVoiceServerFrame[]): string[] {
  return frames.map((frame) => frame.type);
}

export function audioFrame(text: string): {
  type: "audio";
  dataBase64: string;
} {
  return { type: "audio", dataBase64: Buffer.from(text).toString("base64") };
}

/** Drive a turn into the responding phase: final transcript dispatched. */
export async function startRespondingTurn(
  harness: SessionHarness,
  transcript = "hello there",
): Promise<void> {
  await harness.session.start();
  await harness.session.handleClientFrame(audioFrame("user audio"));
  harness.ingest.callbacks.onTranscriptFinal?.(transcript);
  await waitFor(() =>
    harness.frames.some((frame) => frame.type === "thinking"),
  );
}
