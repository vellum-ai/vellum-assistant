/**
 * Managed realtime STT through the gateway's speech relay
 * (gateway → velay → Deepgram; velay contact is gateway-only).
 *
 * Composes {@link DeepgramRealtimeTranscriber} — both relay legs speak
 * Deepgram's live wire protocol verbatim, so all frame handling (Results
 * parsing, backpressure, finalize/flush serialization) is inherited, not
 * duplicated. This wrapper owns what is relay-specific:
 *
 * - Dialing the gateway (`/v1/speech/stt/stream`, `?key=` carries a
 *   daemon-minted service token, no `model` param — the model is pinned
 *   server-side).
 * - Surfacing `velay_error` control frames (velay's own, or synthesized
 *   by the gateway for upstream failures) as categorized SttErrors
 *   instead of generic socket failures.
 * - Transparent re-dial on velay's 30-minute session cap: live-voice
 *   reuses ONE streaming transcriber across utterance cycles (#37662), so
 *   a normal conversation can outlive the cap. Velay settles the in-flight
 *   utterance (trailing finals arrive before the close), then this wrapper
 *   opens a fresh relay session and continues without surfacing an error.
 */

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
import { DeepgramRealtimeTranscriber } from "./deepgram-realtime.js";
import {
  mapVelayError,
  probeVelayRejection,
  type SpeechRelayConnection,
  type VelayErrorInfo,
} from "./vellum-speech-relay-connection.js";

const log = getLogger("vellum-managed-realtime");

const STT_STREAM_PATH = "/v1/speech/stt/stream";

export interface VellumManagedRealtimeOptions {
  /** Audio sample rate in Hz (default: 16000). */
  sampleRate?: number;
  /** BCP-47 language code, forwarded to the relay. */
  language?: string;
  /**
   * Emit `final` events only at utterance boundaries (telephony mode).
   * Note: velay's param allowlist has no `utterance_end_ms`, so boundaries
   * come from Deepgram's endpointing (`speech_final`) alone.
   */
  utteranceBoundaryFinals?: boolean;
}

export class VellumManagedRealtimeTranscriber implements StreamingTranscriber {
  readonly providerId = "vellum" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly connection: SpeechRelayConnection;
  private readonly options: VellumManagedRealtimeOptions;

  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;
  /** The current relay session; null while re-dialing after a session cap. */
  private inner: DeepgramRealtimeTranscriber | null = null;
  /**
   * The most recent `velay_error` frame from the current session. Set just
   * before velay closes the socket; consumed when the inner adapter turns
   * that close into an error event.
   */
  private pendingRelayError: VelayErrorInfo | null = null;
  /**
   * Set when the current session hit velay's duration cap: the swap to a
   * fresh session is deferred to the capped session's `closed` event so
   * its close cleanup (withheld finals, outstanding finalizes) drains
   * through first.
   */
  private redialOnClose = false;
  private stopping = false;
  private closedEmitted = false;

  constructor(
    connection: SpeechRelayConnection,
    options: VellumManagedRealtimeOptions = {},
  ) {
    this.connection = connection;
    this.options = options;
  }

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.onEvent) {
      throw new Error("VellumManagedRealtimeTranscriber: start() called twice");
    }
    this.onEvent = onEvent;
    try {
      const inner = await this.dial();
      if (this.stopping) {
        // stop() raced the initial dial: it saw no inner to tear down and
        // already emitted closed, so the freshly opened relay session must
        // not be kept (a leaked session keeps velay metering).
        inner.stop();
        return;
      }
      this.inner = inner;
    } catch (err) {
      // A failed WebSocket upgrade exposes no HTTP details; replay the
      // request as a plain GET to recover the relay's {code, detail}
      // rejection (the gateway replays its whole gate on non-upgrade
      // requests, including velay's own).
      const rejection = await probeVelayRejection(this.probeUrl());
      if (rejection) {
        throw new Error(mapVelayError(rejection).message);
      }
      throw err;
    }
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    // ponytail: audio arriving during a session-cap re-dial (sub-second) is
    // dropped, mirroring the inner adapter's backpressure-drop semantics;
    // buffer-and-replay if the gap ever proves audible.
    this.inner?.sendAudio(audio, mimeType);
  }

  finalizeUtterance(): void {
    if (this.inner) {
      this.inner.finalizeUtterance();
      return;
    }
    // No live session (re-dialing or closed) — nothing is buffered
    // provider-side, so the flush is trivially complete.
    this.emit({ type: "finalized" });
  }

  stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    if (this.inner) {
      this.inner.stop();
      return;
    }
    // Mid-redial stop: there is no session to drain.
    this.emitClosedOnce();
  }

  // ── Relay session management ─────────────────────────────────────────

  private async dial(): Promise<DeepgramRealtimeTranscriber> {
    this.pendingRelayError = null;
    // Fresh per dial — a session-cap re-dial happens ~30 minutes in, long
    // after any previously minted token expired.
    const inner = new DeepgramRealtimeTranscriber(
      this.connection.mintServiceToken(),
      {
        baseUrl: this.connection.wsBaseUrl,
        path: STT_STREAM_PATH,
        queryAuth: true,
        omitModelParam: true,
        sampleRate: this.options.sampleRate,
        ...(this.options.language ? { language: this.options.language } : {}),
        ...(this.options.utteranceBoundaryFinals
          ? { utteranceBoundaryFinals: true }
          : {}),
        onUnhandledFrame: (frame) => this.handleRelayFrame(frame),
      },
    );
    await inner.start((event) => this.handleInnerEvent(inner, event));
    return inner;
  }

  private probeUrl(): string {
    const key = encodeURIComponent(this.connection.mintServiceToken());
    return `${this.connection.httpBaseUrl}${STT_STREAM_PATH}?key=${key}`;
  }

  private handleRelayFrame(frame: Record<string, unknown>): void {
    if (frame.type !== "velay_error" || typeof frame.code !== "string") {
      return;
    }
    this.pendingRelayError = {
      code: frame.code,
      ...(typeof frame.detail === "string" ? { detail: frame.detail } : {}),
    };
    log.info(
      { code: frame.code, detail: frame.detail },
      "Received velay_error frame on managed STT relay",
    );
  }

  private handleInnerEvent(
    source: DeepgramRealtimeTranscriber,
    event: SttStreamServerEvent,
  ): void {
    // Events from a superseded session (the one replaced by a re-dial)
    // must not leak through — its close/error was already accounted for.
    if (source !== this.inner) {
      return;
    }

    if (event.type === "error") {
      const relayError = this.pendingRelayError;
      if (relayError?.code === "session_duration_exceeded") {
        // Velay's 30-minute cap, not a failure. Swallow the error but keep
        // the capped session current: its close cleanup still flushes
        // withheld boundary finals and settles outstanding finalizes, and
        // those events must drain before the swap. The re-dial happens on
        // its `closed` event.
        this.redialOnClose = !this.stopping;
        return;
      }
      if (relayError) {
        const mapped = mapVelayError(relayError);
        this.emit({
          type: "error",
          category: mapped.category,
          message: mapped.message,
        });
        return;
      }
      this.emit(event);
      return;
    }

    if (event.type === "closed") {
      if (this.redialOnClose && !this.stopping) {
        this.redialOnClose = false;
        this.beginRedial();
        return;
      }
      this.emitClosedOnce();
      return;
    }

    this.emit(event);
  }

  /**
   * Replace the capped session with a fresh one. Detached — audio sent
   * during the swap is dropped (see {@link sendAudio}); a dial failure is
   * a real error and ends the stream.
   */
  private beginRedial(): void {
    log.info("Managed STT relay session hit velay's duration cap — re-dialing");
    this.inner = null;
    void (async () => {
      try {
        const inner = await this.dial();
        if (this.stopping) {
          inner.stop();
          return;
        }
        this.inner = inner;
        log.info("Managed STT relay re-dial complete — session continues");
      } catch (err) {
        if (this.stopping) {
          return;
        }
        this.emit({
          type: "error",
          category: "provider-error",
          message: `Managed speech relay re-dial failed after the session cap: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        this.emitClosedOnce();
      }
    })();
  }

  // ── Event emission ───────────────────────────────────────────────────

  private emit(event: SttStreamServerEvent): void {
    if (!this.onEvent || this.closedEmitted) {
      return;
    }
    if (event.type === "closed") {
      this.closedEmitted = true;
    }
    try {
      this.onEvent(event);
    } catch (err) {
      log.warn(
        { error: err },
        "Listener error in vellum managed realtime adapter",
      );
    }
  }

  private emitClosedOnce(): void {
    this.emit({ type: "closed" });
  }
}
