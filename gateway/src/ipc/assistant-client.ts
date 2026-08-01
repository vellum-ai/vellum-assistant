/**
 * Gateway → assistant reverse IPC client.
 *
 * Connects to the assistant's Unix domain socket (assistant.sock) to make
 * one-shot JSON-RPC calls from the gateway to the assistant daemon.
 *
 * Protocol: the daemon's length-prefixed framing (`@vellumai/ipc-server-utils`),
 * the same one the CLI and route-host clients speak:
 * - Request:  `{ "id": string, "method": string, "params"?: object }`
 * - Response: `{ "id": string, "result"?: unknown, "error"?: string }`
 *
 * Framing rather than the legacy newline dialect because only framing carries
 * a binary frame. The daemon still accepts legacy callers, but a legacy socket
 * cannot send raw request bodies and never receives binary responses — the
 * daemon drops them on the way out.
 *
 * This reverse client stays inline because @vellumai/gateway-client models
 * assistant-to-gateway calls; this path calls the assistant from the gateway.
 */

import { connect, type Socket } from "node:net";

import { IpcFrameReader, writeMessage } from "@vellumai/ipc-server-utils";
import type { IpcEnvelope } from "@vellumai/ipc-server-utils";

import type { ScopeOption, DirectoryScopeOption } from "../risk/risk-types.js";
import { resolveIpcSocketPath } from "./endpoint.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 30_000; // 30s to accommodate LLM latency
const CONNECT_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface IpcResponse extends IpcEnvelope {
  statusCode?: number;
  errorCode?: string;
}

export interface IpcCallOptions {
  /** Bounds connect + response; defaults to 30 seconds. */
  timeoutMs?: number;
  /**
   * Raw request body, delivered to the handler as `rawBody` rather than
   * re-encoded as JSON. The daemon threads it through untouched.
   */
  binary?: Uint8Array;
  /** Extra envelope headers. `content-length` is set for you. */
  headers?: Record<string, string>;
}

export interface IpcCallResult {
  /** The handler's JSON result, when it answered with one. */
  result: unknown;
  /** Response body bytes, when the handler answered with binary or a stream. */
  binary?: Uint8Array;
}

// ---------------------------------------------------------------------------
// Structured IPC errors (used by the gateway IPC proxy)
// ---------------------------------------------------------------------------

/**
 * Error thrown by {@link ipcCallAssistant} when the daemon returns a
 * handler-level error (e.g. a RouteError with statusCode).
 */
export class IpcHandlerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "IpcHandlerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Error thrown by {@link ipcCallAssistant} when the daemon is unreachable
 * (socket error, timeout, closed before response).
 */
export class IpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcTransportError";
  }
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

function getAssistantSocketPath(): string {
  return resolveIpcSocketPath("assistant").path;
}

// ---------------------------------------------------------------------------
// One-shot IPC call to the assistant
// ---------------------------------------------------------------------------

/**
 * One-shot IPC helper: connect to assistant.sock, call a method, disconnect.
 *
 * - On success: resolves with the result value.
 * - On handler error (assistant RouteError): throws {@link IpcHandlerError}
 *   with statusCode and code.
 * - On transport failure (socket not found, timeout, parse error, closed
 *   before response): throws {@link IpcTransportError}.
 *
 * `opts.timeoutMs` bounds the whole call (connect + response) and tears the
 * socket down on expiry; defaults to 30 seconds to accommodate LLM latency
 * on the assistant side.
 */
export async function ipcCallAssistant(
  method: string,
  params?: Record<string, unknown>,
  opts?: IpcCallOptions,
): Promise<unknown> {
  return (await ipcCallAssistantRaw(method, params, opts)).result;
}

/**
 * As {@link ipcCallAssistant}, but surfacing a binary response body.
 *
 * The daemon answers some routes with bytes — a single binary frame, or a
 * chunked stream. Under the legacy protocol those arrived as an envelope with
 * no `result` and the bytes were dropped on the floor; framed, they are
 * delivered here. Chunked responses are accumulated, matching what the daemon
 * used to do for legacy clients, except the bytes now survive the trip.
 */
export async function ipcCallAssistantRaw(
  method: string,
  params?: Record<string, unknown>,
  opts?: IpcCallOptions,
): Promise<IpcCallResult> {
  const socketPath = getAssistantSocketPath();
  const callTimeoutMs = opts?.timeoutMs ?? CALL_TIMEOUT_MS;

  return new Promise<IpcCallResult>((resolve, reject) => {
    let settled = false;

    const finish = (value?: IpcCallResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(callTimer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value ?? { result: undefined });
      }
    };

    const connectTimer = setTimeout(() => {
      finish(
        undefined,
        new IpcTransportError(
          `Connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);

    const callTimer = setTimeout(() => {
      finish(
        undefined,
        new IpcTransportError(`Call timed out after ${callTimeoutMs}ms`),
      );
    }, callTimeoutMs);

    const socket: Socket = connect(socketPath);
    socket.unref();

    const reqId = crypto.randomUUID();

    /** Envelope and chunks of an in-flight chunked response. */
    let streamEnvelope: IpcEnvelope | undefined;
    let streamChunks: Uint8Array[] = [];

    const settleEnvelope = (
      envelope: IpcResponse,
      binary: Uint8Array | undefined,
    ): void => {
      if (envelope.id !== reqId) return;
      if (envelope.error) {
        finish(
          undefined,
          envelope.statusCode
            ? new IpcHandlerError(
                envelope.error,
                envelope.statusCode,
                envelope.errorCode ?? "UNKNOWN",
              )
            : new IpcTransportError(envelope.error),
        );
        return;
      }
      finish({ result: envelope.result, binary });
    };

    const reader = new IpcFrameReader(
      (envelope, binary) => settleEnvelope(envelope as IpcResponse, binary),
      // A malformed frame is unrecoverable for a one-shot call: the stream
      // position is lost, so fail rather than wait out the timeout.
      (err) => finish(undefined, new IpcTransportError(err.message)),
      {
        onStreamStart: (envelope) => {
          streamEnvelope = envelope;
          streamChunks = [];
        },
        onStreamChunk: (chunk) => {
          streamChunks.push(chunk);
        },
        onStreamEnd: () => {
          const envelope = streamEnvelope;
          streamEnvelope = undefined;
          if (!envelope || envelope.id !== reqId) return;
          settleEnvelope(envelope as IpcResponse, concatChunks(streamChunks));
          streamChunks = [];
        },
      },
    );

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      const envelope: IpcEnvelope = { id: reqId, method, params };
      // The reader keys off content-length to expect a following frame, so a
      // request that carries bytes has to announce them.
      if (opts?.binary) {
        envelope.headers = {
          ...opts.headers,
          "content-length": String(opts.binary.byteLength),
        };
      } else if (opts?.headers) {
        envelope.headers = opts.headers;
      }
      writeMessage(socket, envelope, opts?.binary);

      socket.on("data", (chunk) => {
        reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    });

    socket.on("error", (err) => {
      finish(
        undefined,
        new IpcTransportError(err instanceof Error ? err.message : String(err)),
      );
    });

    socket.on("close", () => {
      if (!settled) {
        finish(
          undefined,
          new IpcTransportError("Socket closed before response"),
        );
      }
    });
  });
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

export interface SuggestTrustRuleRequest {
  tool: string;
  command: string;
  riskAssessment: {
    risk: string;
    reasoning: string;
    reasonDescription: string;
  };
  scopeOptions: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  currentThreshold: string; // "low" | "medium" | "high"
  intent: "auto_approve" | "escalate";
  existingRule?: {
    id: string;
    pattern: string;
    risk: string;
  };
}

export interface SuggestTrustRuleResponse {
  pattern: string;
  risk: string; // "low" | "medium" | "high"
  scope?: string;
  description: string;
  scopeOptions: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
}

/**
 * Ask the assistant daemon to suggest a trust rule for a command invocation.
 *
 * Throws if the assistant returns an error or an unexpected response shape.
 */
export async function ipcSuggestTrustRule(
  params: SuggestTrustRuleRequest,
): Promise<SuggestTrustRuleResponse> {
  const result = await ipcCallAssistant("suggest_trust_rule", {
    body: params,
  } as unknown as Record<string, unknown>);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("ipcSuggestTrustRule: unexpected response shape");
  }
  return result as SuggestTrustRuleResponse;
}
