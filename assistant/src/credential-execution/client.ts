/**
 * CES RPC client.
 *
 * Provides a type-safe interface for the assistant to communicate with the
 * Credential Execution Service using the shared @vellumai/ces-contracts
 * schema. The client handles framing (newline-delimited JSON envelopes),
 * request correlation, handshake negotiation, and graceful error handling.
 *
 * The client is transport-agnostic — it accepts a `CesTransport` that
 * abstracts over stdio (local mode) and Unix socket (managed sidecar mode).
 * See `process-manager.ts` and `executable-discovery.ts` for transport
 * setup.
 */

import { randomUUID } from "node:crypto";

import {
  CES_PROTOCOL_VERSION,
  type CesRpcContract,
  CesRpcMethod,
  CesRpcSchemas,
  type HandshakeAck,
  type RpcEnvelope,
  type RpcError,
} from "@vellumai/ces-contracts";

import { getLogger } from "../util/logger.js";

const log = getLogger("ces-client");

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal transport interface that the CES client writes to and reads from.
 *
 * In local mode this wraps the child process's stdin/stdout. In managed mode
 * it wraps a Unix domain socket connection.
 */
export interface CesTransport {
  /** Send a line of text (the transport appends the newline). */
  write(line: string): void;
  /**
   * Register a callback that fires for each complete newline-delimited
   * message received from CES.
   */
  onMessage(handler: (message: string) => void): void;
  /** Whether the transport is still connected / alive. */
  isAlive(): boolean;
  /** Tear down the transport connection. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Pending request bookkeeping
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface CesClientConfig {
  /** Timeout for individual RPC requests (ms). Default: 30 000 */
  requestTimeoutMs?: number;
  /** Timeout for the initial handshake (ms). Default: 10 000 */
  handshakeTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface CesClientHandshakeOptions {
  /**
   * Optional assistant API key to pass to CES during the handshake.
   * In managed (sidecar) mode the API key is provisioned after hatch,
   * so the assistant forwards it here so CES can use it for platform
   * credential materialisation without relying on env vars.
   */
  assistantApiKey?: string;
}

export interface CesClient {
  /**
   * Perform the handshake with CES. Must be called before any RPC calls.
   * Returns true if the handshake was accepted, false otherwise.
   */
  handshake(
    options?: CesClientHandshakeOptions,
  ): Promise<{ accepted: boolean; reason?: string }>;

  /**
   * Send a typed RPC request and wait for the response.
   *
   * The method name, request payload, and response payload are all
   * type-checked against the CesRpcContract.
   */
  call<M extends CesRpcMethod>(
    method: M,
    request: CesRpcContract[M]["request"],
  ): Promise<CesRpcContract[M]["response"]>;

  /**
   * Push an updated assistant API key to CES.
   *
   * In managed mode the API key is provisioned after hatch, so the initial
   * handshake may have been sent without one. This method pushes the key
   * to CES after it arrives, without requiring a re-handshake.
   */
  updateAssistantApiKey(assistantApiKey: string): Promise<{ updated: boolean }>;

  /** Whether the client has completed a successful handshake. */
  isReady(): boolean;

  /** Close the client and underlying transport. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createCesClient(
  transport: CesTransport,
  config?: CesClientConfig,
): CesClient {
  const requestTimeoutMs =
    config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const handshakeTimeoutMs =
    config?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  const sessionId = randomUUID();
  let requestCounter = 0;
  let ready = false;

  const pending = new Map<string, PendingRequest>();

  // -------------------------------------------------------------------------
  // Incoming message dispatch
  // -------------------------------------------------------------------------

  transport.onMessage((raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("Received malformed JSON from CES");
      return;
    }

    // Handshake ack — special handling
    const msg = parsed as Record<string, unknown>;
    if (msg.type === "handshake_ack") {
      const ack = parsed as HandshakeAck;
      const entry = pending.get("handshake");
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete("handshake");
        entry.resolve(ack);
      }
      return;
    }

    // RPC response envelope
    if (msg.kind === "response" && typeof msg.id === "string") {
      const envelope = parsed as RpcEnvelope;
      const entry = pending.get(envelope.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(envelope.id);
        entry.resolve(envelope.payload);
      }
      return;
    }

    log.warn({ msg }, "Received unrecognised message from CES");
  });

  // -------------------------------------------------------------------------
  // Send helpers
  // -------------------------------------------------------------------------

  function sendLine(obj: unknown): void {
    if (!transport.isAlive()) {
      throw new CesTransportError("CES transport is not alive");
    }
    transport.write(JSON.stringify(obj));
  }

  function nextRequestId(): string {
    return `${sessionId}:${++requestCounter}`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    async handshake(
      options?: CesClientHandshakeOptions,
    ): Promise<{ accepted: boolean; reason?: string }> {
      if (ready) return { accepted: true };

      const ackPromise = new Promise<HandshakeAck>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete("handshake");
          reject(
            new CesHandshakeError(
              `CES handshake timed out after ${handshakeTimeoutMs}ms`,
            ),
          );
        }, handshakeTimeoutMs);

        pending.set("handshake", {
          resolve: resolve as (payload: unknown) => void,
          reject,
          timer,
        });
      });

      try {
        sendLine({
          type: "handshake_request",
          protocolVersion: CES_PROTOCOL_VERSION,
          sessionId,
          ...(options?.assistantApiKey
            ? { assistantApiKey: options.assistantApiKey }
            : {}),
        });
      } catch (err) {
        const entry = pending.get("handshake");
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete("handshake");
        }
        throw err;
      }

      const ack = await ackPromise;

      if (ack.accepted) {
        ready = true;
        log.info(
          { protocolVersion: ack.protocolVersion, sessionId },
          "CES handshake accepted",
        );
      } else {
        log.warn({ reason: ack.reason }, "CES handshake rejected");
      }

      return { accepted: ack.accepted, reason: ack.reason };
    },

    async call<M extends CesRpcMethod>(
      method: M,
      request: CesRpcContract[M]["request"],
    ): Promise<CesRpcContract[M]["response"]> {
      if (!ready) {
        throw new CesClientError(
          "CES client has not completed handshake — call handshake() first",
        );
      }

      if (!transport.isAlive()) {
        throw new CesTransportError("CES transport is not alive");
      }

      // Validate request against the shared schema
      const schemas = CesRpcSchemas[method];
      const parseResult = schemas.request.safeParse(request);
      if (!parseResult.success) {
        throw new CesClientError(
          `Invalid CES RPC request for method "${method}": ${parseResult.error.message}`,
        );
      }

      const id = nextRequestId();

      const responsePromise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new CesTimeoutError(
              `CES RPC call "${method}" timed out after ${requestTimeoutMs}ms`,
            ),
          );
        }, requestTimeoutMs);

        pending.set(id, {
          resolve,
          reject,
          timer,
        });
      });

      const envelope: RpcEnvelope = {
        id,
        kind: "request",
        method,
        payload: request,
        timestamp: new Date().toISOString(),
      };

      try {
        sendLine({ type: "rpc", ...envelope });
      } catch (err) {
        const entry = pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(id);
        }
        throw err;
      }

      const rawResponse = await responsePromise;

      // Validate response against the shared schema
      const respParseResult = schemas.response.safeParse(rawResponse);
      if (!respParseResult.success) {
        throw new CesClientError(
          `Invalid CES RPC response for method "${method}": ${respParseResult.error.message}`,
        );
      }

      return respParseResult.data as CesRpcContract[M]["response"];
    },

    async updateAssistantApiKey(
      assistantApiKey: string,
    ): Promise<{ updated: boolean }> {
      return this.call(CesRpcMethod.UpdateManagedCredential, {
        assistantApiKey,
      });
    },

    isReady(): boolean {
      return ready;
    },

    close(): void {
      // Cancel all pending requests
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new CesTransportError("CES client closed"));
        pending.delete(id);
      }
      ready = false;
      transport.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Base class for all CES client errors. */
export class CesClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CesClientError";
  }
}

/** The CES transport is not connected or has been closed. */
export class CesTransportError extends CesClientError {
  constructor(message: string) {
    super(message);
    this.name = "CesTransportError";
  }
}

/** The handshake with CES failed or timed out. */
export class CesHandshakeError extends CesClientError {
  constructor(message: string) {
    super(message);
    this.name = "CesHandshakeError";
  }
}

/** An RPC call to CES timed out. */
export class CesTimeoutError extends CesClientError {
  constructor(message: string) {
    super(message);
    this.name = "CesTimeoutError";
  }
}

/** CES returned an RPC-level error. */
export class CesRpcError extends CesClientError {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(error: RpcError) {
    super(error.message);
    this.name = "CesRpcError";
    this.code = error.code;
    this.details = error.details;
  }
}
