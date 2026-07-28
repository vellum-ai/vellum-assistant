/**
 * xAI TTS WebSocket streaming session.
 *
 * Runs a single-utterance synthesis session against xAI's streaming TTS
 * endpoint (`wss://api.x.ai/v1/tts`): sends the utterance as `text.delta`
 * frames followed by `text.done`, forwards decoded base64 `audio.delta`
 * chunks as they arrive, and resolves with the concatenated audio on
 * `audio.done`. The protocol keeps the socket open for multi-turn use;
 * this session closes it after the one utterance.
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

const log = getLogger("xai-tts-socket");

/** Default timeout (ms) for the WebSocket connection handshake. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Maximum characters per `text.delta` frame, per xAI docs. */
const MAX_TEXT_DELTA_CHARS = 15_000;

/**
 * Minimal structural WebSocket interface so tests can substitute a mock.
 * Trimmed to the surface this module actually uses; kept local so tts/
 * stays free of a cross-subsystem dependency on the STT adapter.
 */
interface WsLike {
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

/** Server frames: `audio.delta` (base64), `audio.done`, `error`. */
interface XaiTtsFrame {
  type?: string;
  delta?: string;
  message?: string;
}

/**
 * Create a WebSocket authenticated via the `Authorization: Bearer` header.
 * Bun's WebSocket constructor supports a second `options` argument with
 * custom headers, unlike the browser WebSocket API.
 */
function createWebSocket(url: string, apiKey: string): WsLike {
  const WebSocketCtor = (
    globalThis as unknown as {
      WebSocket: new (
        url: string,
        options?: { headers?: Record<string, string> },
      ) => WsLike;
    }
  ).WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("global WebSocket is not available in this runtime");
  }
  return new WebSocketCtor(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

export interface XaiTtsSocketOptions extends StreamReadTimeouts {
  /** Full wss:// URL including query params (language, voice, codec, sample_rate…). */
  url: string;
  apiKey: string;
  /** Full utterance text; split into ≤15,000-char text.delta frames. */
  text: string;
  onChunk?: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  /** Error factories keep provider-owned codes/wording (stream-read pattern). */
  makeTimeoutError: (timeoutMs: number) => Error;
  makeStreamError: (detail: string) => Error;
  makeEmptyError: () => Error;
}

/**
 * Synthesize one utterance over an xAI TTS WebSocket, resolving with the
 * complete audio. Chunks are forwarded to `onChunk` as they arrive.
 */
export function synthesizeOverXaiTtsSocket(
  options: XaiTtsSocketOptions,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const { signal, onChunk, makeTimeoutError, makeStreamError, makeEmptyError } =
      options;
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
      ws = createWebSocket(options.url, options.apiKey);
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const chunks: Buffer[] = [];
    let receivedAnyFrame = false;
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
      if (settled) {return;}
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
      fail(abortReason());
    };

    /**
     * (Re)arm the stall timer: first-chunk budget until any server frame
     * arrives, idle budget between frames thereafter. Any server frame
     * counts as activity (mirrors `readChunkedBody`).
     */
    const armStallTimer = () => {
      if (stallTimer !== null) {clearTimeout(stallTimer);}
      const timeoutMs = receivedAnyFrame ? idleTimeoutMs : firstChunkTimeoutMs;
      stallTimer = setTimeout(() => {
        fail(makeTimeoutError(timeoutMs));
      }, timeoutMs);
    };

    connectTimer = setTimeout(() => {
      fail(makeTimeoutError(connectTimeoutMs));
    }, connectTimeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      if (settled) {return;}
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      try {
        const text = options.text;
        let offset = 0;
        while (offset < text.length) {
          let end = Math.min(offset + MAX_TEXT_DELTA_CHARS, text.length);
          // Never split a surrogate pair across delta frames.
          if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
            end -= 1;
          }
          ws.send(
            JSON.stringify({ type: "text.delta", delta: text.slice(offset, end) }),
          );
          offset = end;
        }
        ws.send(JSON.stringify({ type: "text.done" }));
      } catch (err) {
        fail(
          makeStreamError(
            `failed to send text frames: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      armStallTimer();
    });

    ws.addEventListener("message", (ev) => {
      if (settled) {return;}

      receivedAnyFrame = true;
      armStallTimer();

      let raw: string;
      if (typeof ev.data === "string") {
        raw = ev.data;
      } else if (ev.data instanceof ArrayBuffer || ArrayBuffer.isView(ev.data)) {
        raw = new TextDecoder().decode(ev.data);
      } else {
        return;
      }

      let frame: XaiTtsFrame;
      try {
        frame = JSON.parse(raw) as XaiTtsFrame;
      } catch {
        log.debug("Dropped non-JSON xAI TTS frame");
        return;
      }
      if (!frame || typeof frame !== "object") {return;}

      switch (frame.type) {
        case "audio.delta": {
          if (typeof frame.delta !== "string") {return;}
          const chunk = Buffer.from(frame.delta, "base64");
          if (chunk.byteLength === 0) {return;}
          chunks.push(chunk);
          try {
            onChunk?.(chunk);
          } catch (err) {
            // Propagate sink failures like readChunkedBody: fail the session.
            fail(err);
          }
          return;
        }

        case "audio.done":
          settle(() => {
            closeSocket();
            if (chunks.length === 0) {
              reject(makeEmptyError());
              return;
            }
            resolve(Buffer.concat(chunks));
          });
          return;

        case "error":
          // One-shot session: fatal even though the protocol leaves the
          // socket open after an error frame.
          fail(
            makeStreamError(
              typeof frame.message === "string"
                ? frame.message
                : "xAI error frame",
            ),
          );
          return;

        default:
          // Unknown frame types are informational — ignored.
          return;
      }
    });

    ws.addEventListener("close", (ev) => {
      fail(
        makeStreamError(
          `socket closed before audio.done (code=${ev.code}, reason=${ev.reason})`,
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
