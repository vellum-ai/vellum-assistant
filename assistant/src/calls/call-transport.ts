/**
 * Transport interface consumed by CallController for sending voice output
 * and controlling call lifecycle.
 *
 * Decouples the controller from any specific wire protocol (e.g. Twilio
 * Media Streams) so that alternative transports can be introduced without
 * modifying controller logic.
 */

// ── Transport interface ──────────────────────────────────────────────

/**
 * Minimal output surface that CallController uses to send speech,
 * audio, and lifecycle signals to the caller.
 */
export interface CallTransport {
  /**
   * Send a text token for TTS playback. When `last` is true the
   * transport should signal end-of-turn to the caller.
   */
  sendTextToken(token: string, last: boolean): void;

  /**
   * Send a pre-synthesized audio URL for playback.
   */
  sendPlayUrl(url: string): void;

  /**
   * Signal the transport to end the call session.
   */
  endSession(reason?: string): void;

  /**
   * When true, the transport requires WAV (PCM) audio for playback.
   *
   * The media-stream transport sets this because its mu-law transcoder
   * can only decode WAV (raw PCM) — compressed formats (mp3, opus)
   * produce garbled audio. The call controller uses this to request
   * WAV from TTS providers and the audio store.
   */
  readonly requiresWavAudio?: boolean;

  /**
   * Arm a one-shot callback invoked when the transport sends the first
   * audio frame of queued playback to the caller.
   *
   * Transports that buffer text and synthesize asynchronously (e.g.
   * media-stream) implement this so the controller can flip to the
   * `speaking` state only when real outbound audio starts, rather than
   * when tokens are merely buffered. Passing `null` disarms the signal.
   * Transports that emit audio immediately may omit this.
   */
  setAudioStartCallback?(cb: (() => void) | null): void;

  /**
   * Discard any buffered, not-yet-queued text held by the transport.
   *
   * Called by the controller when it aborts an in-flight turn so the
   * aborted turn's unsent text cannot leak into the next turn's
   * synthesis. Transports that don't buffer text may omit this.
   */
  discardPendingText?(): void;

  /**
   * Cancel queued and in-flight speech playback held by the transport,
   * including any audio already buffered downstream (e.g. by Twilio).
   *
   * Called by the controller when it aborts an in-flight turn so speech
   * the aborted turn queued for synthesis or playback never plays over
   * the next turn. Transports that emit speech synchronously may omit
   * this.
   */
  cancelPendingSpeech?(): void;
}
