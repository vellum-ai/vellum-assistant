import { Buffer } from "node:buffer";

import {
  listProviderIds,
  supportsBoundary,
} from "../providers/speech-to-text/provider-catalog.js";
import type { ResolveStreamingTranscriberOptions } from "../providers/speech-to-text/resolve.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";
import type {
  LiveVoiceSession as LiveVoiceSessionContract,
  LiveVoiceSessionCloseReason,
  LiveVoiceSessionFactoryContext,
} from "./live-voice-session-manager.js";
import {
  type LiveVoiceClientFrame,
  LiveVoiceProtocolErrorCode,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

type LiveVoiceSessionState =
  | "initializing"
  | "active"
  | "utterance_released"
  | "transcriber_closed"
  | "failed"
  | "closed";

export type LiveVoiceStreamingTranscriberResolver = (
  options: ResolveStreamingTranscriberOptions,
) => Promise<StreamingTranscriber | null>;

export interface LiveVoiceSessionOptions {
  resolveTranscriber?: LiveVoiceStreamingTranscriberResolver;
}

export class LiveVoiceSession implements LiveVoiceSessionContract {
  private readonly context: LiveVoiceSessionFactoryContext;
  private readonly resolveTranscriber: LiveVoiceStreamingTranscriberResolver;
  private readonly conversationId: string;
  private state: LiveVoiceSessionState = "initializing";
  private transcriber: StreamingTranscriber | null = null;
  private readonly finalTranscriptSegments: string[] = [];
  private outboundFrames: Promise<void> = Promise.resolve();

  constructor(
    context: LiveVoiceSessionFactoryContext,
    options: LiveVoiceSessionOptions = {},
  ) {
    this.context = context;
    this.resolveTranscriber =
      options.resolveTranscriber ?? defaultResolveStreamingTranscriber;
    this.conversationId =
      context.startFrame.conversationId ?? context.sessionId;
  }

  get finalTranscriptText(): string {
    return this.finalTranscriptSegments.join(" ");
  }

  async start(): Promise<void> {
    if (this.state !== "initializing") return;

    try {
      const transcriber = await this.resolveTranscriber({
        sampleRate: this.context.startFrame.audio.sampleRate,
      });

      if (this.isClosed) {
        stopTranscriberBestEffort(transcriber);
        return;
      }

      if (!transcriber) {
        this.state = "failed";
        await this.sendFrame({
          type: "error",
          code: LiveVoiceProtocolErrorCode.InvalidField,
          message: unavailableTranscriberMessage(),
        });
        return;
      }

      this.transcriber = transcriber;
      await transcriber.start((event) => {
        void this.handleTranscriberEvent(event);
      });

      if (this.isClosed) {
        stopTranscriberBestEffort(transcriber);
        this.transcriber = null;
        return;
      }

      this.state = "active";
      await this.sendFrame({
        type: "ready",
        sessionId: this.context.sessionId,
        conversationId: this.conversationId,
      });
    } catch (err) {
      stopTranscriberBestEffort(this.transcriber);
      this.transcriber = null;
      if (this.isClosed) return;

      this.state = "failed";
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice transcription could not be started: ${errorMessage(
          err,
        )}`,
      });
    }
  }

  async handleClientFrame(frame: LiveVoiceClientFrame): Promise<void> {
    if (this.state === "closed" || this.state === "failed") return;

    switch (frame.type) {
      case "audio":
        await this.handleAudio(Buffer.from(frame.dataBase64, "base64"));
        return;
      case "ptt_release":
        await this.releaseUtterance();
        return;
      case "interrupt":
        return;
      case "end":
        await this.close("client_end");
        return;
      case "start":
        return;
    }
  }

  async handleBinaryAudio(chunk: Uint8Array): Promise<void> {
    await this.handleAudio(Buffer.from(chunk));
  }

  async close(_reason: LiveVoiceSessionCloseReason): Promise<void> {
    if (this.isClosed) return;

    this.state = "closed";
    stopTranscriberBestEffort(this.transcriber);
    this.transcriber = null;
    await this.drainOutboundFrames();
  }

  private async handleAudio(chunk: Buffer): Promise<void> {
    if (
      this.state === "utterance_released" ||
      this.state === "transcriber_closed"
    ) {
      await this.sendAudioAfterReleaseError();
      return;
    }

    if (this.state !== "active") return;

    try {
      this.transcriber?.sendAudio(
        chunk,
        this.context.startFrame.audio.mimeType,
      );
      await this.drainOutboundFrames();
    } catch (err) {
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidAudioPayload,
        message: `Live voice audio could not be sent to transcription: ${errorMessage(
          err,
        )}`,
      });
    }
  }

  private async releaseUtterance(): Promise<void> {
    if (
      this.state === "utterance_released" ||
      this.state === "transcriber_closed"
    ) {
      return;
    }

    if (this.state !== "active") return;

    this.state = "utterance_released";
    try {
      this.transcriber?.stop();
    } catch (err) {
      await this.sendFrame({
        type: "error",
        code: LiveVoiceProtocolErrorCode.InvalidField,
        message: `Live voice transcription could not be stopped: ${errorMessage(
          err,
        )}`,
      });
    }
    await this.drainOutboundFrames();
  }

  private async handleTranscriberEvent(
    event: SttStreamServerEvent,
  ): Promise<void> {
    if (this.isClosed || this.state === "failed") return;

    switch (event.type) {
      case "partial":
        await this.sendFrame({ type: "stt_partial", text: event.text });
        return;
      case "final": {
        const transcript = event.text.trim();
        if (transcript.length > 0) {
          this.finalTranscriptSegments.push(transcript);
        }
        await this.sendFrame({ type: "stt_final", text: event.text });
        return;
      }
      case "error":
        await this.sendFrame({
          type: "error",
          code: LiveVoiceProtocolErrorCode.InvalidField,
          message: event.message,
        });
        return;
      case "closed":
        if (!this.isClosed) {
          this.state = "transcriber_closed";
          this.transcriber = null;
        }
        return;
    }
  }

  private async sendAudioAfterReleaseError(): Promise<void> {
    await this.sendFrame({
      type: "error",
      code: LiveVoiceProtocolErrorCode.InvalidAudioPayload,
      message: "Live voice audio received after push-to-talk release.",
    });
  }

  private async sendFrame(frame: LiveVoiceServerFramePayload): Promise<void> {
    this.outboundFrames = this.outboundFrames
      .catch(() => {})
      .then(async () => {
        await this.context.sendFrame(frame);
      })
      .catch(() => {
        // Transport failures are handled by the WebSocket/session owner.
      });

    await this.outboundFrames;
  }

  private async drainOutboundFrames(): Promise<void> {
    await this.outboundFrames.catch(() => {});
  }

  private get isClosed(): boolean {
    return this.state === "closed";
  }
}

export function createLiveVoiceSession(
  context: LiveVoiceSessionFactoryContext,
  options: LiveVoiceSessionOptions = {},
): LiveVoiceSession {
  return new LiveVoiceSession(context, options);
}

async function defaultResolveStreamingTranscriber(
  options: ResolveStreamingTranscriberOptions,
): Promise<StreamingTranscriber | null> {
  const { resolveStreamingTranscriber } =
    await import("../providers/speech-to-text/resolve.js");
  return resolveStreamingTranscriber(options);
}

function unavailableTranscriberMessage(): string {
  const supportedProviders = listProviderIds()
    .filter((id) => supportsBoundary(id, "daemon-streaming"))
    .join(", ");

  return `Live voice transcription is unavailable. Check that the configured STT provider supports streaming transcription and has credentials configured. Streaming-capable providers: ${supportedProviders}.`;
}

function stopTranscriberBestEffort(
  transcriber: StreamingTranscriber | null,
): void {
  if (!transcriber) return;

  try {
    transcriber.stop();
  } catch {
    // Best effort cleanup during failed startup or session close.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
