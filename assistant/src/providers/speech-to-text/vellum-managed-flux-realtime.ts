/**
 * Managed Flux STT through the gateway's speech relay
 * (gateway -> velay -> Deepgram Flux; velay contact is gateway-only).
 *
 * Composes {@link DeepgramFluxRealtimeTranscriber} against the relay's
 * managed STT v2 endpoint with `contract=flux`, so Flux's own turn events
 * arrive verbatim. Without that opt-in velay translates them into the
 * released v1 Deepgram dialect, which drops `EagerEndOfTurn` and
 * `TurnResumed` entirely and leaves live voice with no provider turn end to
 * act on.
 *
 * This wrapper owns what is relay-specific, mirroring
 * `VellumManagedRealtimeTranscriber` on the v1 path:
 *
 * - Dialing the gateway (`/v2/speech/stt/stream`, `?key=` carries a
 *   daemon-minted service token, no `model` param since velay derives and
 *   prices the Flux model from `language`).
 * - Surfacing `velay_error` control frames as categorized SttErrors instead
 *   of generic socket failures.
 * - Transparent re-dial on velay's 30-minute session cap, so one live-voice
 *   session can outlive it.
 *
 * There is deliberately no `finalizeUtterance`: Flux commits turns itself,
 * and the interface makes the method optional so live voice feature-detects
 * its absence and never asks for a flush.
 */

import {
  type StreamingTranscriber,
  SttError,
  type SttStreamServerEvent,
} from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
import { DeepgramFluxRealtimeTranscriber } from "./deepgram-flux-realtime.js";
import {
  mapVelayError,
  probeVelayRejection,
  type SpeechRelayConnection,
  type VelayErrorInfo,
} from "./vellum-speech-relay-connection.js";

const log = getLogger("vellum-managed-flux-realtime");

/** Managed STT v2: velay resolves this to Deepgram's Flux `/v2/listen`. */
const STT_STREAM_PATH = "/v2/speech/stt/stream";

export interface VellumManagedFluxRealtimeOptions {
  /** Audio sample rate in Hz (default: 16000). */
  sampleRate?: number;
  /**
   * BCP-47 language code (or `"multi"`), forwarded to the relay. This is
   * how velay picks between `flux-general-en` and `flux-general-multi`, so
   * it is the only lever over the Flux model from this side.
   */
  language?: string;
}

export class VellumManagedFluxRealtimeTranscriber implements StreamingTranscriber {
  readonly providerId = "vellum-flux" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly connection: SpeechRelayConnection;
  private readonly options: VellumManagedFluxRealtimeOptions;

  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;
  /** The current relay session; null while re-dialing after a session cap. */
  private inner: DeepgramFluxRealtimeTranscriber | null = null;
  /**
   * The most recent `velay_error` frame from the current session. Set just
   * before velay closes the socket; consumed when the inner adapter turns
   * that close into an error event.
   */
  private pendingRelayError: VelayErrorInfo | null = null;
  /**
   * Set when the current session hit velay's duration cap: the swap to a
   * fresh session is deferred to the capped session's `closed` event so its
   * close cleanup drains through first.
   */
  private redialOnClose = false;
  private stopping = false;
  private closedEmitted = false;

  constructor(
    connection: SpeechRelayConnection,
    options: VellumManagedFluxRealtimeOptions = {},
  ) {
    this.connection = connection;
    this.options = options;
  }

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.onEvent) {
      throw new Error(
        "VellumManagedFluxRealtimeTranscriber: start() called twice",
      );
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
      // rejection.
      const rejection = await probeVelayRejection(this.probeUrl());
      if (rejection) {
        const mapped = mapVelayError(rejection);
        throw new SttError(mapped.category, mapped.message, {
          userFacing: true,
        });
      }
      throw err;
    }
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    // Audio arriving during a session-cap re-dial (sub-second) is dropped,
    // mirroring the inner adapter's backpressure-drop semantics.
    this.inner?.sendAudio(audio, mimeType);
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

  // -- Relay session management ------------------------------------------

  private async dial(): Promise<DeepgramFluxRealtimeTranscriber> {
    this.pendingRelayError = null;
    // Fresh per dial: a session-cap re-dial happens ~30 minutes in, long
    // after any previously minted token expired.
    const inner = new DeepgramFluxRealtimeTranscriber(
      this.connection.mintServiceToken(),
      {
        baseUrl: this.connection.wsBaseUrl,
        path: STT_STREAM_PATH,
        queryAuth: true,
        omitModelParam: true,
        nativeContract: true,
        ...(this.options.sampleRate !== undefined
          ? { sampleRate: this.options.sampleRate }
          : {}),
        ...(this.options.language ? { language: this.options.language } : {}),
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
      "Received velay_error frame on managed Flux relay",
    );
  }

  private handleInnerEvent(
    source: DeepgramFluxRealtimeTranscriber,
    event: SttStreamServerEvent,
  ): void {
    // Events from a superseded session (the one replaced by a re-dial) must
    // not leak through: its close/error was already accounted for.
    if (source !== this.inner) {
      return;
    }

    if (event.type === "error") {
      const relayError = this.pendingRelayError;
      if (relayError?.code === "session_duration_exceeded") {
        // Velay's 30-minute cap, not a failure. Swallow the error but keep
        // the capped session current so its close cleanup drains first; the
        // re-dial happens on its `closed` event.
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
   * Replace the capped session with a fresh one. Detached: audio sent during
   * the swap is dropped (see {@link sendAudio}); a dial failure is a real
   * error and ends the stream.
   */
  private beginRedial(): void {
    log.info("Managed Flux relay session hit velay's duration cap, re-dialing");
    this.inner = null;
    void (async () => {
      try {
        const inner = await this.dial();
        if (this.stopping) {
          inner.stop();
          return;
        }
        this.inner = inner;
        log.info("Managed Flux relay re-dial complete; session continues");
      } catch (err) {
        if (this.stopping) {
          return;
        }
        const rejection = await probeVelayRejection(this.probeUrl());
        if (rejection) {
          const mapped = mapVelayError(rejection);
          this.emit({
            type: "error",
            category: mapped.category,
            message: mapped.message,
          });
        } else {
          this.emit({
            type: "error",
            category: "provider-error",
            message: `Managed Flux relay re-dial failed after the session cap: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        this.emitClosedOnce();
      }
    })();
  }

  // -- Event emission -----------------------------------------------------

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
        "Listener error in vellum managed Flux realtime adapter",
      );
    }
  }

  private emitClosedOnce(): void {
    this.emit({ type: "closed" });
  }
}
