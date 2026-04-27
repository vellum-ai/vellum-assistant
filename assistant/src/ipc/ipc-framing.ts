/**
 * Length-prefixed binary framing for the IPC protocol.
 *
 * Wire format: [4-byte big-endian length][payload bytes]
 *
 * Messages use a JSON envelope. When the envelope's `headers` map contains
 * a `content-length` key, a binary data frame immediately follows the JSON
 * frame.
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
  // Shared — when headers["content-length"] is present, a binary frame follows
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Streaming reader that accumulates socket data and emits parsed messages.
 * Handles both legacy newline-delimited JSON and new length-prefixed frames.
 */
export class IpcFrameReader {
  private buffer = Buffer.alloc(0);
  private onMessage: (
    envelope: IpcEnvelope,
    binary: Uint8Array | undefined,
  ) => void;
  private onError: (err: Error) => void;

  // State machine for length-prefixed reading
  private state: "detect" | "read-length" | "read-payload" | "read-binary" =
    "detect";
  private pendingLength = 0;
  private pendingEnvelope: IpcEnvelope | null = null;
  private expectBinary = false;

  /** Whether this connection uses the legacy newline-delimited protocol. */
  isLegacy = false;

  constructor(
    onMessage: (
      envelope: IpcEnvelope,
      binary: Uint8Array | undefined,
    ) => void,
    onError?: (err: Error) => void,
  ) {
    this.onMessage = onMessage;
    this.onError = onError ?? (() => {});
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
