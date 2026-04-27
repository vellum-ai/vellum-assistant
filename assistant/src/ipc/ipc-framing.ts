/**
 * Length-prefixed binary framing for the IPC protocol.
 *
 * Wire format: [4-byte big-endian length][payload bytes]
 *
 * Messages use a JSON envelope. When the envelope's `headers` map contains
 * a `content-length` key, a single binary data frame immediately follows
 * the JSON frame.
 *
 * Chunked streaming: when `headers["transfer-encoding"]` is `"chunked"`,
 * multiple binary data frames follow the JSON envelope. A zero-length
 * frame (4 bytes of 0x00) terminates the stream. This enables streaming
 * responses (e.g. audio, SSE) over IPC without buffering the full payload.
 *
 * Backward compatibility: the reader detects legacy newline-delimited JSON
 * by checking if the first byte is `{` (0x7B). New-format frames always
 * start with a 4-byte length prefix whose first byte is < 0x7B for any
 * realistic message size (< 2 GB).
 */

import type { Socket } from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IpcEnvelope {
  id: string;
  // Request fields
  method?: string;
  params?: Record<string, unknown>;
  // Response fields
  result?: unknown;
  error?: string;
  // Shared — when headers["content-length"] is present, a binary frame follows.
  // When headers["transfer-encoding"] is "chunked", multiple binary frames
  // follow until a zero-length terminator.
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write a length-prefixed frame to a socket. */
function writeFrame(socket: Socket, data: Buffer | Uint8Array): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  socket.write(header);
  socket.write(data);
}

/**
 * Write an IPC envelope, optionally followed by a binary data frame.
 * If `binary` is provided, the envelope's headers must include content-length.
 */
export function writeMessage(
  socket: Socket,
  envelope: IpcEnvelope,
  binary?: Uint8Array,
): void {
  const json = Buffer.from(JSON.stringify(envelope), "utf-8");
  writeFrame(socket, json);
  if (binary) {
    writeFrame(socket, binary);
  }
}

/**
 * Write a legacy newline-delimited JSON message.
 * Used when the client connected with the legacy protocol.
 */
export function writeLegacyMessage(
  socket: Socket,
  envelope: IpcEnvelope,
): void {
  socket.write(JSON.stringify(envelope) + "\n");
}

/**
 * Write a single chunk in a chunked transfer stream.
 * The envelope must have already been sent with transfer-encoding: chunked.
 */
export function writeStreamChunk(socket: Socket, chunk: Uint8Array): void {
  writeFrame(socket, chunk);
}

/**
 * Write a zero-length frame to signal the end of a chunked transfer stream.
 */
export function writeStreamEnd(socket: Socket): void {
  const terminator = Buffer.alloc(4); // 4 bytes of 0x00 = length 0
  socket.write(terminator);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Callback for complete messages (non-streaming). */
export type OnMessageCallback = (
  envelope: IpcEnvelope,
  binary: Uint8Array | undefined,
) => void;

/** Callbacks for chunked streaming responses. */
export interface StreamCallbacks {
  onStreamStart: (envelope: IpcEnvelope) => void;
  onStreamChunk: (chunk: Uint8Array) => void;
  onStreamEnd: () => void;
}

/**
 * Streaming reader that accumulates socket data and emits parsed messages.
 * Handles both legacy newline-delimited JSON and new length-prefixed frames.
 *
 * Supports three response modes:
 * 1. JSON-only: envelope with no binary follow-up
 * 2. Binary: envelope with content-length → single binary frame
 * 3. Chunked: envelope with transfer-encoding: chunked → multiple binary
 *    frames terminated by a zero-length frame
 */
export class IpcFrameReader {
  private buffer = Buffer.alloc(0);
  private onMessage: OnMessageCallback;
  private onError: (err: Error) => void;
  private streamCallbacks: StreamCallbacks | undefined;

  // State machine for length-prefixed reading
  private state:
    | "detect"
    | "read-length"
    | "read-payload"
    | "read-binary"
    | "read-stream-chunk-length"
    | "read-stream-chunk" = "detect";
  private pendingLength = 0;
  private pendingEnvelope: IpcEnvelope | null = null;
  private expectBinary = false;

  /** Whether this connection uses the legacy newline-delimited protocol. */
  isLegacy = false;

  constructor(
    onMessage: OnMessageCallback,
    onError?: (err: Error) => void,
    streamCallbacks?: StreamCallbacks,
  ) {
    this.onMessage = onMessage;
    this.onError = onError ?? (() => {});
    this.streamCallbacks = streamCallbacks;
  }

  /** Feed incoming socket data into the reader. */
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    while (true) {
      if (this.state === "detect") {
        if (this.buffer.length === 0) return;
        // Legacy detection: first byte is '{' (0x7B)
        if (this.buffer[0] === 0x7b) {
          this.isLegacy = true;
          this.drainLegacy();
          return;
        }
        // New format — fall through to read-length
        this.state = "read-length";
      }

      if (this.state === "read-length") {
        if (this.buffer.length < 4) return;
        this.pendingLength = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.subarray(4);
        this.state = this.expectBinary ? "read-binary" : "read-payload";
      }

      if (this.state === "read-payload") {
        if (this.buffer.length < this.pendingLength) return;
        const payload = this.buffer.subarray(0, this.pendingLength);
        this.buffer = this.buffer.subarray(this.pendingLength);

        let envelope: IpcEnvelope;
        try {
          envelope = JSON.parse(payload.toString("utf-8")) as IpcEnvelope;
        } catch {
          this.onError(new Error("Invalid JSON in IPC frame"));
          this.state = "detect";
          continue;
        }

        const transferEncoding = envelope.headers?.["transfer-encoding"];
        if (transferEncoding === "chunked") {
          // Chunked streaming — emit start, then read chunks until terminator
          this.pendingEnvelope = envelope;
          this.streamCallbacks?.onStreamStart(envelope);
          this.state = "read-stream-chunk-length";
          continue;
        }

        const contentLength = envelope.headers?.["content-length"];
        if (contentLength != null) {
          // Binary frame follows
          this.pendingEnvelope = envelope;
          this.expectBinary = true;
          this.state = "read-length";
        } else {
          this.onMessage(envelope, undefined);
          this.expectBinary = false;
          this.state = "detect";
        }
        continue;
      }

      if (this.state === "read-binary") {
        if (this.buffer.length < this.pendingLength) return;
        const binary = new Uint8Array(
          this.buffer.subarray(0, this.pendingLength),
        );
        this.buffer = this.buffer.subarray(this.pendingLength);

        this.onMessage(this.pendingEnvelope!, binary);
        this.pendingEnvelope = null;
        this.expectBinary = false;
        this.state = "detect";
        continue;
      }

      // Chunked streaming states
      if (this.state === "read-stream-chunk-length") {
        if (this.buffer.length < 4) return;
        this.pendingLength = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.subarray(4);

        if (this.pendingLength === 0) {
          // Zero-length frame = end of stream
          this.streamCallbacks?.onStreamEnd();
          this.pendingEnvelope = null;
          this.state = "detect";
          continue;
        }

        this.state = "read-stream-chunk";
      }

      if (this.state === "read-stream-chunk") {
        if (this.buffer.length < this.pendingLength) return;
        const chunk = new Uint8Array(
          this.buffer.subarray(0, this.pendingLength),
        );
        this.buffer = this.buffer.subarray(this.pendingLength);

        this.streamCallbacks?.onStreamChunk(chunk);
        this.state = "read-stream-chunk-length";
        continue;
      }
    }
  }

  /**
   * Legacy mode: parse newline-delimited JSON lines.
   * Once we enter legacy mode, we stay in it for the lifetime of the connection.
   */
  private drainLegacy(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf(0x0a)) !== -1) {
      const line = this.buffer.subarray(0, newlineIdx).toString("utf-8").trim();
      this.buffer = this.buffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const envelope = JSON.parse(line) as IpcEnvelope;
        this.onMessage(envelope, undefined);
      } catch {
        this.onError(new Error("Invalid JSON in legacy IPC line"));
      }
    }
  }
}
