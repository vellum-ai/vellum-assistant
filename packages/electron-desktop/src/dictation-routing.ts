import type { WebContents } from "electron";

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

  clear(): void {
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
}

const live = (target: WebContents | null): WebContents | null =>
  target && !target.isDestroyed() ? target : null;
