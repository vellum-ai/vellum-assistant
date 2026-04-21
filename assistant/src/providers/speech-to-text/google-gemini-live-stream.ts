/**
 * Google Gemini Live API streaming STT adapter.
 *
 * Opens a bidirectional streaming session against Gemini's Live API
 * (`ai.live.connect`), forwards PCM audio frames from the caller, and
 * normalizes the server's `inputAudioTranscription` events into the
 * daemon's {@link SttStreamServerEvent} contract with stable partial/final
 * semantics.
 *
 * Design notes:
 * - Uses a long-lived WebSocket-backed session (not periodic REST polls).
 * - The server emits transcription events natively via
 *   `serverContent.inputTranscription`; we do not diff responses ourselves.
 * - Suppresses the model's text turn (`responseModalities: [TEXT]`,
 *   system instruction telling the model to stay silent) so we only pay
 *   for transcription work.
 *
 * Lifecycle:
 * 1. {@link start} opens the Live session and resolves on `onopen`.
 * 2. {@link sendAudio} forwards PCM chunks via `session.sendRealtimeInput`.
 * 3. {@link stop} sends `audioStreamEnd: true` and waits for the server
 *    to flush any remaining transcription before closing.
 * 4. The `onEvent` callback receives `partial`, `final`, `error`, and
 *    `closed` events throughout the session lifetime.
 *
 * Error handling mirrors {@link DeepgramRealtimeTranscriber}: close-code
 * categorization (`auth` for 1008/4001, `rate-limit` for 1013,
 * `provider-error` for everything else), a configurable inactivity
 * timeout, and idempotent cleanup.
 */

import type { LiveServerMessage, Session } from "@google/genai";
import { GoogleGenAI, Modality } from "@google/genai";

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("google-gemini-live-stream");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default Gemini Live-capable model. See the @google/genai SDK example at
 * `@google/genai/dist/node/node.d.ts` (class `Live.connect`) — the Gemini
 * Live API currently ships under the `gemini-live-2.5-flash-preview` id.
 */
const DEFAULT_MODEL = "gemini-live-2.5-flash-preview";

/**
 * Default timeout (ms) for the Live session handshake.
 * If `onopen` does not fire within this window, start() rejects.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Default inactivity timeout (ms). If no message is received from Gemini
 * for this duration after the session is open, the adapter closes with a
 * timeout error. This guards against provider-side hangs.
 */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000;

/**
 * Grace period (ms) after signaling `audioStreamEnd` before we force-close
 * the Live session. Gives Gemini time to flush any remaining transcription.
 */
const CLOSE_GRACE_MS = 5_000;

/**
 * System instruction asking the model not to generate output. The Live API
 * always attempts to respond; telling it to stay silent minimizes wasted
 * tokens and avoids polluting our event stream with unwanted model turns.
 */
const SILENT_SYSTEM_INSTRUCTION =
  "You are a silent transcription service. Do not respond to the user. Only transcribe the audio input.";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GoogleGeminiLiveStreamOptions {
  /** Gemini Live model to use (default: "gemini-live-2.5-flash-preview"). */
  model?: string;
  /** Override the Google AI API base URL (useful for proxies or on-prem). */
  baseUrl?: string;
  /** Sample rate for raw PCM input; used when normalizing MIME types. */
  pcmSampleRate?: number;
  /** Connect timeout in milliseconds. Default: 10_000. */
  connectTimeoutMs?: number;
  /** Inactivity timeout in milliseconds. Default: 30_000. */
  inactivityTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * Google Gemini Live API streaming transcriber.
 *
 * Implements the daemon {@link StreamingTranscriber} contract on top of
 * Gemini's bidirectional Live API with server-side input transcription.
 */
export class GoogleGeminiLiveStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "google-gemini" as const;
  readonly boundaryId = "daemon-streaming" as const;

  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly pcmSampleRate: number;
  private readonly connectTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;

  /** The live session, set during start(). */
  private session: Session | null = null;

  /** Callback for emitting events to the session orchestrator. */
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  /** Whether the session has been fully closed. */
  private closed = false;

  /** Whether stop() has been called. */
  private stopping = false;

  /** Inactivity timer handle. */
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  /** Close grace timer handle. */
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Last partial transcript we emitted; used to dedupe repeats. */
  private lastEmittedPartial = "";

  /** Accumulated input transcription for the current turn. */
  private currentTurnText = "";

  /**
   * Whether we've already emitted a `final` event for the current turn
   * via a completion signal (`turnComplete` / `generationComplete` /
   * `inputTranscription.finished`). Reset when a new turn's text begins
   * accumulating. Used by `flushFinalAndClose` to avoid emitting a
   * trailing empty final when the provider closes normally after stop()
   * has already flushed a final for the turn.
   */
  private finalEmittedForCurrentTurn = false;

  constructor(apiKey: string, options: GoogleGeminiLiveStreamOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.pcmSampleRate = options.pcmSampleRate ?? 16_000;
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.inactivityTimeoutMs =
      options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;

    this.client = options.baseUrl
      ? new GoogleGenAI({
          apiKey,
          httpOptions: { baseUrl: options.baseUrl },
        })
      : new GoogleGenAI({ apiKey });
  }

  // ── StreamingTranscriber interface ──────────────────────────────────

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    if (this.session || this.onEvent) {
      throw new Error(
        "GoogleGeminiLiveStreamingTranscriber: start() called twice",
      );
    }
    this.onEvent = onEvent;
    this.closed = false;
    this.stopping = false;
    this.lastEmittedPartial = "";
    this.currentTurnText = "";
    this.finalEmittedForCurrentTurn = false;

    log.info({ model: this.model }, "Opening Gemini Live session");

    // Open is complete when BOTH the session handle is returned by the
    // SDK AND `onopen` has fired. The real SDK's `live.connect()` awaits
    // `onopen` internally before resolving with a Session; we track the
    // two signals separately so the adapter stays correct across SDK
    // ordering changes and matches the test mock (which returns the
    // session synchronously and fires `onopen` on the next microtask).
    let openFired = false;
    let resolveOpen: (() => void) | null = null;
    let rejectOpen: ((err: Error) => void) | null = null;
    const openSignal = new Promise<void>((res, rej) => {
      resolveOpen = res;
      rejectOpen = rej;
    });

    const finishOpen = (err?: Error): void => {
      if (err) {
        rejectOpen?.(err);
      } else {
        resolveOpen?.();
      }
      resolveOpen = null;
      rejectOpen = null;
    };

    const connectPromise = this.client.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: {},
        systemInstruction: SILENT_SYSTEM_INSTRUCTION,
      },
      callbacks: {
        onopen: (): void => {
          openFired = true;
          finishOpen();
        },
        onmessage: (msg: LiveServerMessage): void => {
          this.handleServerMessage(msg);
        },
        onerror: (ev: ErrorEvent): void => {
          if (!openFired && !this.session) {
            finishOpen(
              new Error(`Gemini Live connect error: ${this.describeError(ev)}`),
            );
            return;
          }
          this.handleProviderError(ev);
        },
        onclose: (ev: CloseEvent): void => {
          if (!openFired && !this.session) {
            finishOpen(
              new Error(
                `Gemini Live session closed before open (code=${ev.code}, reason=${ev.reason})`,
              ),
            );
            return;
          }
          this.handleProviderClose(ev.code, ev.reason);
        },
      },
    });

    // Capture the session as soon as the SDK returns it so subsequent
    // methods have a handle. A failed connect (rejection) is surfaced
    // below via the race path.
    let timedOut = false;
    connectPromise
      .then((session) => {
        if (timedOut || this.closed || this.stopping) {
          // Never assign a session after shutdown or timeout: if we did,
          // `this.session` would persist as an orphaned live WebSocket.
          try {
            session.close();
          } catch {
            // best effort
          }
          return;
        }
        this.session = session;
      })
      .catch(() => {
        // Surfaced through the Promise.race below.
      });

    // Timeout race.
    const timeoutPromise = new Promise<never>((_, rej) => {
      const timer = setTimeout(() => {
        timedOut = true;
        log.warn("Gemini Live connect timeout");
        rej(new Error("Gemini Live connect timeout"));
      }, this.connectTimeoutMs);
      // Clear the timer only once open has actually fired; a resolved
      // `connectPromise` alone does not mean the session is open (the
      // test mock returns the session synchronously and defers onopen).
      openSignal.finally(() => clearTimeout(timer)).catch(() => {});
    });

    try {
      // Wait for the SDK's connect() to resolve (giving us `this.session`)
      // AND for `onopen` to have fired, or for either a timeout or
      // connect error to fail the race.
      await Promise.race([
        Promise.all([connectPromise, openSignal]),
        timeoutPromise,
      ]);
    } catch (err) {
      this.onEvent = null;
      // The connectPromise may have already resolved with a session
      // handle before the timeout fired — if so, the `.then()` above
      // captured it on `this.session`. Close any such orphaned session
      // here to prevent leaking a live WebSocket to the provider.
      this.forceCloseSession();
      throw err;
    }

    this.resetInactivityTimer();
    log.info("Gemini Live session opened");
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    if (this.closed || this.stopping) return;

    const session = this.session;
    if (!session) return;

    const normalizedMimeType = this.normalizePcmMimeType(mimeType);

    try {
      session.sendRealtimeInput({
        audio: {
          data: audio.toString("base64"),
          mimeType: normalizedMimeType,
        },
      });
    } catch (err) {
      log.warn({ error: err }, "Failed to send audio to Gemini Live session");
    }
  }

  stop(): void {
    if (this.closed || this.stopping) return;
    this.stopping = true;

    log.info("Stopping Gemini Live session");

    const session = this.session;
    if (!session) {
      this.emitClosedAndCleanup();
      return;
    }

    // Signal end-of-audio so Gemini flushes any pending transcription.
    try {
      session.sendRealtimeInput({ audioStreamEnd: true });
    } catch (err) {
      // If the send fails, force-close immediately.
      log.warn({ error: err }, "Failed to send audioStreamEnd; forcing close");
      this.flushFinalAndClose();
      return;
    }

    // Start a grace timer — if the provider doesn't close within the
    // grace window, we force-close to prevent session leaks.
    this.closeGraceTimer = setTimeout(() => {
      log.warn("Gemini Live close grace timeout — forcing close");
      this.flushFinalAndClose();
    }, CLOSE_GRACE_MS);
  }

  // ── Provider message handling ───────────────────────────────────────

  private handleServerMessage(msg: LiveServerMessage): void {
    if (this.closed) return;

    this.resetInactivityTimer();

    // Session-level setup/usage/goAway signals — log and proceed.
    if (msg.setupComplete) {
      log.debug("Gemini Live setupComplete received");
    }
    if (msg.usageMetadata) {
      log.debug({ usage: msg.usageMetadata }, "Gemini Live usageMetadata");
    }
    if (msg.goAway) {
      log.info(
        { timeLeft: msg.goAway.timeLeft },
        "Gemini Live goAway received — treating as graceful close",
      );
    }

    const serverContent = msg.serverContent;
    if (!serverContent) return;

    // Append any new input transcription text to the current turn buffer.
    // A new turn begins when we see text while the buffer is empty —
    // reset the "final already emitted" flag so the next completion
    // signal can emit again.
    const transcriptionText = serverContent.inputTranscription?.text;
    if (typeof transcriptionText === "string" && transcriptionText.length > 0) {
      if (this.currentTurnText.length === 0) {
        this.finalEmittedForCurrentTurn = false;
      }
      this.currentTurnText += transcriptionText;
    }

    // Detect turn completion. Per the `@google/genai` SDK docs,
    // `inputTranscription` is independent of the model's response turn,
    // so we honor `Transcription.finished` as an additional completion
    // signal alongside `turnComplete` / `generationComplete`.
    const isComplete =
      serverContent.inputTranscription?.finished === true ||
      serverContent.generationComplete === true ||
      serverContent.turnComplete === true;

    if (isComplete) {
      if (this.finalEmittedForCurrentTurn) return;
      const finalText = this.currentTurnText;
      this.currentTurnText = "";
      this.lastEmittedPartial = "";
      this.finalEmittedForCurrentTurn = true;
      this.emitEvent({ type: "final", text: finalText });
      return;
    }

    // During the stop() grace period we still accumulate text (above)
    // so any flushed final is complete, but we suppress partials — the
    // session orchestrator does not want interleaved partials between
    // stop() and the final emission.
    if (this.stopping) return;

    // Otherwise emit a partial only if text has changed.
    if (
      this.currentTurnText.length > 0 &&
      this.currentTurnText !== this.lastEmittedPartial
    ) {
      this.lastEmittedPartial = this.currentTurnText;
      this.emitEvent({ type: "partial", text: this.currentTurnText });
    }

    // `modelTurn` content is ignored — we only care about input
    // transcription, not the model's response.
  }

  /**
   * Handle provider-side session close.
   */
  private handleProviderClose(code: number, reason: string): void {
    if (this.closed) return;

    // Normal close (1000) or going-away (1001) after stop() is expected.
    if (this.stopping && (code === 1000 || code === 1001)) {
      log.info({ code, reason }, "Gemini Live session closed normally");
      this.flushFinalAndClose();
      return;
    }

    log.warn({ code, reason }, "Gemini Live session closed unexpectedly");

    const category =
      code === 1008 || code === 4001
        ? ("auth" as const)
        : code === 1013
          ? ("rate-limit" as const)
          : ("provider-error" as const);

    this.emitEvent({
      type: "error",
      category,
      message: `Gemini Live session closed (code=${code}, reason=${reason})`,
    });
    this.emitClosedAndCleanup();
  }

  /**
   * Handle provider-side error event.
   */
  private handleProviderError(ev: unknown): void {
    if (this.closed) return;

    const message = this.describeError(ev);
    log.error({ error: ev }, "Gemini Live session error");

    this.emitEvent({
      type: "error",
      category: "provider-error",
      message: `Gemini Live session error: ${message}`,
    });
    this.emitClosedAndCleanup();
  }

  // ── Event emission & cleanup ────────────────────────────────────────

  /**
   * Emit a server event to the session orchestrator. Swallows listener
   * errors to prevent tearing down the adapter.
   *
   * Drops events after `closed` to preserve the streaming contract.
   */
  private emitEvent(event: SttStreamServerEvent): void {
    if (!this.onEvent) return;
    if (this.closed && event.type !== "closed") return;
    try {
      this.onEvent(event);
    } catch (err) {
      log.warn({ error: err }, "Listener error in Gemini Live adapter");
    }
  }

  /**
   * Flush any pending transcription as a final event, then close. Used
   * when the provider closes normally after stop() or when the close
   * grace timer fires.
   *
   * Avoids emitting a spurious empty-string final when the server
   * already emitted a completion signal (`turnComplete` / `finished` /
   * `generationComplete`) for the current turn before closing — that
   * path already emitted the final and drained the accumulator. The
   * stream contract callers (e.g. Meet's storage-writer) would write
   * an empty transcript line on the extra final, so we suppress it.
   */
  private flushFinalAndClose(): void {
    if (this.closed) return;
    const pending = this.currentTurnText;
    const alreadyEmitted = this.finalEmittedForCurrentTurn;
    this.currentTurnText = "";
    this.lastEmittedPartial = "";
    this.finalEmittedForCurrentTurn = false;
    if (!(alreadyEmitted && pending.length === 0)) {
      this.emitEvent({ type: "final", text: pending });
    }
    this.emitClosedAndCleanup();
  }

  /**
   * Emit a `closed` event and clean up all resources (timers, session).
   * Idempotent — safe to call multiple times.
   */
  private emitClosedAndCleanup(): void {
    if (this.closed) return;
    this.closed = true;

    this.clearTimers();
    this.forceCloseSession();

    this.emitEvent({ type: "closed" });
    this.onEvent = null;
  }

  /**
   * Force-close the Live session without emitting events. Used during
   * cleanup and timeout paths.
   */
  private forceCloseSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;

    try {
      session.close();
    } catch {
      // Best effort — already-closed sessions may throw.
    }
  }

  /**
   * Clear all active timers.
   */
  private clearTimers(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.closeGraceTimer !== null) {
      clearTimeout(this.closeGraceTimer);
      this.closeGraceTimer = null;
    }
  }

  /**
   * Reset the inactivity timer. Called on inbound provider messages to
   * detect provider-side hangs. Not reset on outbound audio sends —
   * continuous audio from the caller must not mask a silent provider.
   */
  private resetInactivityTimer(): void {
    if (this.closed || this.stopping) return;

    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      if (this.closed) return;

      log.warn("Gemini Live inactivity timeout");
      this.emitEvent({
        type: "error",
        category: "timeout",
        message: "Gemini Live session timed out due to inactivity",
      });
      this.emitClosedAndCleanup();
    }, this.inactivityTimeoutMs);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Normalize generic PCM MIME types to include the sample-rate hint that
   * Gemini Live requires. Passes non-PCM MIME types through unchanged.
   *
   * When the input lacks a `rate=` parameter, we append `;rate=<N>` to
   * the original string rather than rebuilding from scratch, so
   * auxiliary parameters (e.g. `encoding=linear16`) and the caller's
   * original casing are preserved.
   */
  private normalizePcmMimeType(mimeType: string): string {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    if (base !== "audio/pcm") return mimeType;
    // Preserve an explicit rate= parameter if the caller supplied one.
    if (/rate\s*=\s*\d+/i.test(mimeType)) return mimeType;
    return `${mimeType};rate=${this.pcmSampleRate}`;
  }

  /**
   * Produce a human-readable message from an unknown error-like value.
   */
  private describeError(ev: unknown): string {
    if (ev instanceof Error) return ev.message;
    if (typeof ev === "object" && ev !== null) {
      if ("message" in ev) {
        const m = (ev as { message: unknown }).message;
        if (m !== undefined && m !== null) return String(m);
      }
      if ("error" in ev) {
        const e = (ev as { error: unknown }).error;
        if (e instanceof Error) return e.message;
        if (e !== undefined && e !== null) return String(e);
      }
    }
    return "Gemini Live session error";
  }
}
