/**
 * Vellum managed TTS WebSocket streaming session.
 *
 * Runs a single-utterance synthesis session against the gateway's managed
 * speech relay (`/v1/speech/tts/stream`, gateway → velay → Deepgram; velay
 * contact is gateway-only). The wire protocol is Deepgram's Speak
 * WebSocket: `Speak` text frames followed by one `Flush`; binary audio
 * frames stream down until a `Flushed` control frame marks the utterance
 * complete. The relay adds one control frame of its own — `velay_error`,
 * surfaced through the caller-owned `makeRelayError` factory.
 *
 * Error codes/wording are caller-owned via error factories (stream-read
 * pattern), keeping this module free of provider imports.
 */

import { getLogger } from "../../util/logger.js";
import { isHighSurrogate } from "../../util/unicode.js";
import type { StreamReadTimeouts } from "../stream-read.js";
import {
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from "../stream-read.js";

const log = getLogger("vellum-tts-socket");

/** Default timeout (ms) for the WebSocket connection handshake. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Maximum characters per Deepgram `Speak` frame. */
const MAX_SPEAK_CHARS = 2_000;

/**
 * Minimal structural WebSocket interface so tests can substitute a mock.
 * Mirrors xai-tts-socket's local copy — kept local so tts/ stays free of
 * a cross-subsystem dependency on the STT adapter.
 */
interface WsLike {
  binaryType?: string;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (ev: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown }) => void,
  ): void;
}

/**
 * Relay control frames: Deepgram's `Metadata`/`Flushed`/`Warning` plus the
 * relay's own `velay_error`.
 */
interface RelayTtsFrame {
  type?: string;
  code?: string;
  detail?: string;
  description?: string;
}

/**
 * Create the relay WebSocket. Auth rides in the URL (`?key=` carries the
 * daemon-minted gateway service token), so no headers are needed.
 */
function createWebSocket(url: string): WsLike {
  const WebSocketCtor = (
    globalThis as unknown as {
      WebSocket: new (url: string) => WsLike;
    }
  ).WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("global WebSocket is not available in this runtime");
  }
  const ws = new WebSocketCtor(url);
  try {
    ws.binaryType = "arraybuffer";
  } catch {
    // Test fakes may not implement the setter.
  }
  return ws;
}

export interface VellumTtsSocketOptions extends StreamReadTimeouts {
  /** Full ws(s):// relay URL including `?key=` and audio params. */
  url: string;
  /** Full utterance text; split into ≤2,000-char Speak frames. */
  text: string;
  onChunk?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  /** Error factories keep provider-owned codes/wording (stream-read pattern). */
  makeTimeoutError: (timeoutMs: number) => Error;
  makeStreamError: (detail: string) => Error;
  makeEmptyError: () => Error;
  /** A `velay_error` control frame arrived — code per the relay contract. */
  makeRelayError: (code: string, detail: string) => Error;
}

/**
 * Synthesize one utterance over the managed speech relay, resolving with
 * the complete audio. Binary chunks are forwarded to `onChunk` as they
 * arrive. Abort sends `Clear` (barge-in: discard buffered synthesis)
 * before closing the socket.
 */
export function synthesizeOverVellumTtsSocket(
  options: VellumTtsSocketOptions,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const {
      signal,
      onChunk,
      makeTimeoutError,
      makeStreamError,
      makeEmptyError,
      makeRelayError,
    } = options;
    const connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const firstChunkTimeoutMs =
      options.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const abortReason = () =>
      signal?.reason ??
      new DOMException("This operation was aborted", "AbortError");

    if (signal?.aborted) {
      reject(abortReason());
      return;
    }

    let ws: WsLike;
    try {
      ws = createWebSocket(options.url);
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    let opened = false;
    const chunks: Buffer[] = [];
    let receivedAudio = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };

    const closeSocket = () => {
      try {
        ws.close();
      } catch {
        // Best effort — already-closed sockets may throw.
      }
    };

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const fail = (err: unknown) => {
      settle(() => {
        closeSocket();
        reject(err);
      });
    };

    const onAbort = () => {
      // Barge-in: tell the provider to discard buffered synthesis before
      // tearing the socket down, so unspoken audio is not generated.
      if (opened) {
        try {
          ws.send(JSON.stringify({ type: "Clear" }));
          ws.send(JSON.stringify({ type: "Close" }));
        } catch {
          // The socket may already be closing.
        }
      }
      fail(abortReason());
    };

    /**
     * (Re)arm the stall timer: first-chunk budget until AUDIO arrives, idle
     * budget between audio chunks thereafter. Only audio drives the timer.
     * Unlike the xAI session (where the first server frame is audio),
     * Deepgram emits control frames (Metadata, Warning) around the audio —
     * counting them would either collapse the first-chunk budget to the
     * shorter idle budget, or let a stuck stream that heartbeats control
     * frames without ever producing audio stay open indefinitely.
     */
    const armStallTimer = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
      }
      const timeoutMs = receivedAudio ? idleTimeoutMs : firstChunkTimeoutMs;
      stallTimer = setTimeout(() => {
        fail(makeTimeoutError(timeoutMs));
      }, timeoutMs);
    };

    connectTimer = setTimeout(() => {
      fail(makeTimeoutError(connectTimeoutMs));
    }, connectTimeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      if (settled) {
        return;
      }
      opened = true;
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      try {
        const text = options.text;
        let offset = 0;
        while (offset < text.length) {
          let end = Math.min(offset + MAX_SPEAK_CHARS, text.length);
          // Never split a surrogate pair across Speak frames.
          if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
            end -= 1;
          }
          ws.send(
            JSON.stringify({ type: "Speak", text: text.slice(offset, end) }),
          );
          offset = end;
        }
        ws.send(JSON.stringify({ type: "Flush" }));
      } catch (err) {
        fail(
          makeStreamError(
            `failed to send Speak frames: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      armStallTimer();
    });

    ws.addEventListener("message", (ev) => {
      if (settled) {
        return;
      }

      // Binary frames are the audio itself — and the only thing that
      // feeds the stall timer.
      if (ev.data instanceof ArrayBuffer || ArrayBuffer.isView(ev.data)) {
        receivedAudio = true;
        armStallTimer();
      }

      if (ev.data instanceof ArrayBuffer) {
        const chunk = Buffer.from(ev.data);
        if (chunk.byteLength === 0) {
          return;
        }
        chunks.push(chunk);
        try {
          onChunk?.(chunk);
        } catch (err) {
          // Propagate sink failures like readChunkedBody: fail the session.
          fail(err);
        }
        return;
      }
      if (ArrayBuffer.isView(ev.data)) {
        const view = ev.data as ArrayBufferView;
        const chunk = Buffer.from(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        if (chunk.byteLength === 0) {
          return;
        }
        chunks.push(Buffer.from(chunk));
        try {
          onChunk?.(chunk);
        } catch (err) {
          fail(err);
        }
        return;
      }
      if (typeof ev.data !== "string") {
        return;
      }

      let frame: RelayTtsFrame;
      try {
        frame = JSON.parse(ev.data) as RelayTtsFrame;
      } catch {
        log.debug("Dropped non-JSON relay TTS frame");
        return;
      }
      if (!frame || typeof frame !== "object") {
        return;
      }

      switch (frame.type) {
        case "Flushed":
          // All audio for the flushed text has been delivered.
          settle(() => {
            try {
              ws.send(JSON.stringify({ type: "Close" }));
            } catch {
              // Best effort — the audio is already complete.
            }
            closeSocket();
            if (chunks.length === 0) {
              reject(makeEmptyError());
              return;
            }
            resolve(Buffer.concat(chunks));
          });
          return;

        case "velay_error":
          fail(
            makeRelayError(
              typeof frame.code === "string" ? frame.code : "upstream_error",
              typeof frame.detail === "string" ? frame.detail : "",
            ),
          );
          return;

        case "Warning":
          log.warn(
            { description: frame.description },
            "Relay TTS warning frame",
          );
          return;

        default:
          // Metadata and other control frames are informational.
          return;
      }
    });

    ws.addEventListener("close", (ev) => {
      fail(
        makeStreamError(
          `socket closed before Flushed (code=${ev.code}, reason=${ev.reason})`,
        ),
      );
    });

    ws.addEventListener("error", (ev) => {
      const message =
        ev instanceof Error
          ? ev.message
          : typeof ev === "object" && ev !== null && "message" in ev
            ? String((ev as { message: unknown }).message)
            : "WebSocket error";
      fail(makeStreamError(message));
    });
  });
}
