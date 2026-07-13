/**
 * OpenAI Whisper incremental-batch streaming STT adapter.
 *
 * OpenAI Whisper does not expose a native WebSocket streaming transcription
 * endpoint, so this adapter rides the shared incremental-batch strategy —
 * see `incremental-batch-stream.ts` for the accumulation/diff semantics.
 */

import {
  IncrementalBatchStreamingTranscriber,
  type IncrementalBatchStreamOptions,
} from "./incremental-batch-stream.js";
import { whisperTranscribe } from "./openai-whisper.js";

export type OpenAIWhisperStreamOptions = IncrementalBatchStreamOptions;

export class OpenAIWhisperStreamingTranscriber extends IncrementalBatchStreamingTranscriber {
  readonly providerId = "openai-whisper" as const;

  private readonly apiKey: string;

  constructor(apiKey: string, options: IncrementalBatchStreamOptions = {}) {
    super(options);
    this.apiKey = apiKey;
  }

  protected runBatchTranscription(
    audio: Buffer,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<string> {
    return whisperTranscribe(this.apiKey, audio, mimeType, signal);
  }
}
