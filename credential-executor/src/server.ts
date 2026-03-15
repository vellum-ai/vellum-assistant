/**
 * CES RPC server.
 *
 * Implements the server-side of the CES wire protocol defined in
 * `@vellumai/ces-contracts`. The server reads newline-delimited JSON
 * messages from a readable stream, dispatches them through the RPC
 * contract, and writes responses back to a writable stream.
 *
 * Transport-agnostic: callers provide the readable/writable pair.
 * - Local mode: stdin/stdout
 * - Managed mode: the accepted Unix socket stream
 *
 * The server handles the handshake, validates envelopes, dispatches
 * method calls, and sends structured responses or errors.
 */

import type { Readable, Writable } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  type CesRpcMethod,
  CesRpcSchemas,
  type HandshakeAck,
  type HandshakeRequest,
  type RpcEnvelope,
  type TransportMessage,
  TransportMessageSchema,
} from "@vellumai/ces-contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Handler function for a single RPC method. Receives the validated
 * request payload and returns the response payload (or throws).
 */
export type RpcMethodHandler<TReq = unknown, TRes = unknown> = (
  request: TReq,
) => Promise<TRes> | TRes;

/**
 * Registry of method name to handler function.
 */
export type RpcHandlerRegistry = Partial<
  Record<string, RpcMethodHandler>
>;

export interface CesServerOptions {
  /** Readable stream to consume messages from. */
  input: Readable;
  /** Writable stream to send responses to. */
  output: Writable;
  /** Map of RPC method names to handler functions. */
  handlers: RpcHandlerRegistry;
  /** Optional logger (defaults to console). */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Optional abort signal to shut down the server. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

export class CesRpcServer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly handlers: RpcHandlerRegistry;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly signal?: AbortSignal;

  private handshakeComplete = false;
  private sessionId: string | null = null;
  private buffer = "";
  private closed = false;

  constructor(options: CesServerOptions) {
    this.input = options.input;
    this.output = options.output;
    this.handlers = options.handlers;
    this.logger = options.logger ?? console;
    this.signal = options.signal;
  }

  /**
   * Start serving. Returns a promise that resolves when the input stream
   * ends or the abort signal fires.
   */
  async serve(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.signal?.aborted) {
        this.close();
        resolve();
        return;
      }

      const onAbort = () => {
        this.close();
        resolve();
      };

      if (this.signal) {
        this.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.input.on("data", (chunk: Buffer | string) => {
        if (this.closed) return;
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        this.processBuffer();
      });

      this.input.on("end", () => {
        if (this.signal) {
          this.signal.removeEventListener("abort", onAbort);
        }
        this.close();
        resolve();
      });

      this.input.on("error", (err) => {
        if (this.signal) {
          this.signal.removeEventListener("abort", onAbort);
        }
        this.close();
        reject(err);
      });
    });
  }

  /** Whether the server has completed the handshake. */
  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }

  /** The session ID established during handshake (null before handshake). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Shut down the server gracefully. */
  close(): void {
    this.closed = true;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger.warn("[ces-server] Failed to parse JSON line:", line);
      return;
    }

    // Parse as a transport message
    const msgResult = TransportMessageSchema.safeParse(parsed);
    if (!msgResult.success) {
      this.logger.warn(
        "[ces-server] Invalid transport message:",
        msgResult.error,
      );
      return;
    }

    const msg = msgResult.data as TransportMessage;

    if (msg.type === "handshake_request") {
      this.handleHandshake(msg as HandshakeRequest);
    } else if (msg.type === "rpc") {
      this.handleRpcEnvelope(msg as unknown as RpcEnvelope);
    } else {
      this.logger.warn("[ces-server] Unexpected message type:", msg.type);
    }
  }

  private handleHandshake(req: HandshakeRequest): void {
    const accepted = req.protocolVersion === CES_PROTOCOL_VERSION;
    const ack: HandshakeAck = {
      type: "handshake_ack",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: req.sessionId,
      accepted,
      ...(accepted ? {} : { reason: `Unsupported protocol version: ${req.protocolVersion}` }),
    };

    if (accepted) {
      this.handshakeComplete = true;
      this.sessionId = req.sessionId;
      this.logger.log(`[ces-server] Handshake accepted for session ${req.sessionId}`);
    } else {
      this.logger.warn(
        `[ces-server] Handshake rejected: version mismatch (got ${req.protocolVersion}, expected ${CES_PROTOCOL_VERSION})`,
      );
    }

    this.sendMessage(ack);
  }

  private async handleRpcEnvelope(envelope: RpcEnvelope): Promise<void> {
    if (!this.handshakeComplete) {
      this.logger.warn("[ces-server] RPC received before handshake; ignoring");
      this.sendRpcError(envelope, "HANDSHAKE_REQUIRED", "Handshake not completed");
      return;
    }

    if (envelope.kind !== "request") {
      // Server only processes requests; responses are ignored
      return;
    }

    const method = envelope.method;
    const handler = this.handlers[method];

    if (!handler) {
      this.sendRpcError(envelope, "METHOD_NOT_FOUND", `Unknown method: ${method}`);
      return;
    }

    // Validate the request payload against the registered schema (if available)
    const schemas = CesRpcSchemas[method as CesRpcMethod];
    let validatedPayload = envelope.payload;

    if (schemas) {
      const parseResult = schemas.request.safeParse(envelope.payload);
      if (!parseResult.success) {
        this.sendRpcError(
          envelope,
          "INVALID_REQUEST",
          `Invalid payload for ${method}: ${parseResult.error.message}`,
        );
        return;
      }
      validatedPayload = parseResult.data;
    }

    try {
      const result = await handler(validatedPayload);
      this.sendRpcResponse(envelope, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendRpcError(envelope, "HANDLER_ERROR", message);
    }
  }

  private sendRpcResponse(request: RpcEnvelope, payload: unknown): void {
    const response: RpcEnvelope & { type: "rpc" } = {
      type: "rpc",
      id: request.id,
      kind: "response",
      method: request.method,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.sendMessage(response);
  }

  private sendRpcError(
    request: RpcEnvelope,
    code: string,
    message: string,
  ): void {
    const response: RpcEnvelope & { type: "rpc" } = {
      type: "rpc",
      id: request.id,
      kind: "response",
      method: request.method,
      payload: {
        success: false,
        error: { code, message },
      },
      timestamp: new Date().toISOString(),
    };
    this.sendMessage(response);
  }

  private sendMessage(msg: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(msg) + "\n";
    this.output.write(line);
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a CES RPC server with the given options and start serving.
 *
 * This is the primary entrypoint for both local and managed modes —
 * callers just provide different input/output streams.
 */
export function createCesServer(options: CesServerOptions): CesRpcServer {
  return new CesRpcServer(options);
}
