import type { WebContents } from "electron";
import { z } from "zod";

import type { DictationTranscribeResult } from "@vellumai/ipc-contract";

export const dictationPartialsHelperResultSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
  tap: z.string().optional(),
});

export const dictationTranscribeHelperResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const DICTATION_PUSH_SAMPLE_RATE = 16000;

/**
 * Normalizes a renderer-pushed PCM chunk into a Buffer. Structured clone
 * delivers the worklet's 16 kHz mono Int16 frames as a `Uint8Array` or a raw
 * `ArrayBuffer` depending on how the renderer transferred them.
 */
export const toAudioBuffer = (chunk: unknown): Buffer | null => {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(chunk));
  }
  return null;
};

/**
 * Routes dictation events to the renderer hosting the recording session.
 * The finalized transcript and the final partial flush arrive after partials
 * are disabled, so the window that just stopped recording stays addressable
 * until another window takes over.
 */
export class DictationOwnerRouter {
  private partialsOwner: WebContents | null = null;
  private finalOwner: WebContents | null = null;
  private transcriptionOwner: {
    requestId: string | undefined;
    webContents: WebContents;
  } | null = null;

  /** Records ownership for an enable/disable call, returning the prior owner. */
  setOwner(webContents: WebContents, enable: boolean): WebContents | null {
    const previous = this.partialsOwner;
    this.partialsOwner = enable ? webContents : null;
    this.finalOwner = webContents;
    return previous;
  }

  /** Redirects post-session events at a window, without granting audio push. */
  setFinalOwner(webContents: WebContents): void {
    this.finalOwner = webContents;
  }

  setTranscriptionOwner(
    webContents: WebContents,
    requestId?: string,
  ): WebContents | null {
    const previous = this.transcriptionTarget();
    this.transcriptionOwner = { requestId, webContents };
    return previous;
  }

  clear(): void {
    this.clearStreaming();
    this.transcriptionOwner = null;
  }

  clearStreaming(): void {
    this.partialsOwner = null;
    this.finalOwner = null;
  }

  /** Whether the sender may push audio into the active session. */
  ownsPartials(webContents: WebContents): boolean {
    return this.partialsOwner === webContents;
  }

  target(): WebContents | null {
    return live(this.partialsOwner) ?? live(this.finalOwner);
  }

  transcriptionTarget(): WebContents | null {
    return live(this.transcriptionOwner?.webContents ?? null);
  }

  takeTranscriptionTarget(requestId?: string): WebContents | null {
    const owner = this.transcriptionOwner;
    if (!owner || owner.requestId !== requestId) {
      return null;
    }
    const target = live(owner.webContents);
    this.transcriptionOwner = null;
    return target;
  }

  clearTranscriptionOwner(webContents: WebContents, requestId?: string): void {
    const owner = this.transcriptionOwner;
    if (
      owner &&
      owner.requestId === requestId &&
      owner.webContents === webContents
    ) {
      this.transcriptionOwner = null;
    }
  }
}

export const requestDictationTranscription = async (options: {
  audio: unknown;
  sender: WebContents;
  owners: DictationOwnerRouter;
  client: {
    call(method: string, params?: unknown): Promise<unknown>;
  };
  requestId?: string;
  onOwnerReplaced?: (owner: WebContents) => void;
}): Promise<DictationTranscribeResult> => {
  const buf = toAudioBuffer(options.audio);
  if (!buf || buf.length === 0) {
    return { ok: false, reason: "empty audio" };
  }

  const previousOwner = options.owners.setTranscriptionOwner(
    options.sender,
    options.requestId,
  );
  if (previousOwner && previousOwner !== options.sender) {
    options.onOwnerReplaced?.(previousOwner);
  }
  try {
    const result = dictationTranscribeHelperResultSchema.safeParse(
      await options.client.call("dictation.transcribe", {
        audio: buf.toString("base64"),
        sampleRate: DICTATION_PUSH_SAMPLE_RATE,
        ...(options.requestId ? { requestId: options.requestId } : {}),
      }),
    );
    if (!result.success) {
      options.owners.clearTranscriptionOwner(options.sender, options.requestId);
      return {
        ok: false,
        reason: "native helper returned an invalid transcribe result",
      };
    }
    if (!result.data.ok) {
      options.owners.clearTranscriptionOwner(options.sender, options.requestId);
    }
    return result.data;
  } catch (err) {
    options.owners.clearTranscriptionOwner(options.sender, options.requestId);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

const live = (target: WebContents | null): WebContents | null =>
  target && !target.isDestroyed() ? target : null;
