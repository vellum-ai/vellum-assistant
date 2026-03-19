/**
 * @vellumai/ces-contracts
 *
 * Neutral wire-protocol contracts for communication between the assistant
 * daemon and the Credential Execution Service (CES). This package is
 * intentionally free of imports from `assistant/` or any CES implementation
 * module so that both sides can depend on it without circular references.
 */

import { z } from "zod/v4";
import { RpcErrorSchema } from "./error.js";

// ---------------------------------------------------------------------------
// Transport handshake
// ---------------------------------------------------------------------------

/** Semantic version of the CES wire protocol. */
export const CES_PROTOCOL_VERSION = "0.1.0" as const;

/**
 * Sent by the initiator (assistant) when opening a CES transport channel.
 * The responder (CES) replies with a HandshakeAck.
 */
export const HandshakeRequestSchema = z.object({
  type: z.literal("handshake_request"),
  protocolVersion: z.string(),
  /** Opaque session identifier chosen by the initiator. */
  sessionId: z.string(),
  /**
   * Optional assistant API key passed from the assistant runtime.
   * In managed (sidecar) mode the API key is provisioned after hatch,
   * so the assistant forwards it during the bootstrap handshake so CES
   * can use it for platform credential materialisation.
   */
  assistantApiKey: z.string().optional(),
});
export type HandshakeRequest = z.infer<typeof HandshakeRequestSchema>;

export const HandshakeAckSchema = z.object({
  type: z.literal("handshake_ack"),
  protocolVersion: z.string(),
  sessionId: z.string(),
  /** Whether the responder accepted the requested protocol version. */
  accepted: z.boolean(),
  /** Human-readable reason when `accepted` is false. */
  reason: z.string().optional(),
});
export type HandshakeAck = z.infer<typeof HandshakeAckSchema>;

// ---------------------------------------------------------------------------
// RPC envelope
// ---------------------------------------------------------------------------

/**
 * Every message on the wire is wrapped in an RpcEnvelope so both sides can
 * demux by `method`, correlate responses via `id`, and distinguish requests
 * from responses via `kind`.
 */
export const RpcEnvelopeSchema = z.object({
  /** Monotonically increasing per-session request id. */
  id: z.string(),
  kind: z.enum(["request", "response"]),
  method: z.string(),
  /** JSON-serialisable payload; schema depends on `method`. */
  payload: z.unknown(),
  /** ISO-8601 timestamp of when the message was created. */
  timestamp: z.string(),
});
export type RpcEnvelope = z.infer<typeof RpcEnvelopeSchema>;

// ---------------------------------------------------------------------------
// RPC error (defined in error.ts to avoid circular deps with rpc.ts)
// ---------------------------------------------------------------------------

export {
  RpcErrorSchema,
  type RpcError,
  MANAGED_LOCAL_STATIC_REJECTION_ERROR,
} from "./error.js";

// ---------------------------------------------------------------------------
// Tool request / response base shapes
// ---------------------------------------------------------------------------

/**
 * Base shape for a tool execution request sent from the assistant to CES.
 * Concrete tool requests extend this with tool-specific `params`.
 */
export const ToolRequestBaseSchema = z.object({
  /** The tool identifier as known to both sides. */
  toolName: z.string(),
  /** Opaque handle referencing the credential context for this execution. */
  credentialHandle: z.string(),
  /** Tool-specific parameters; schema varies per tool. */
  params: z.record(z.string(), z.unknown()),
});
export type ToolRequestBase = z.infer<typeof ToolRequestBaseSchema>;

/**
 * Base shape for a tool execution response sent from CES back to the
 * assistant. Modeled as a discriminated union on `success` so malformed
 * payloads (e.g. `success: false` without `error`, or `success: true`
 * with `error`) are rejected at parse time.
 */
const ToolResponseSuccessSchema = z
  .object({
    success: z.literal(true),
    /** Tool output. */
    result: z.unknown().optional(),
  })
  .strict();

const ToolResponseErrorSchema = z.object({
  success: z.literal(false),
  /** Structured error describing the failure. */
  error: RpcErrorSchema,
});

export const ToolResponseBaseSchema = z.discriminatedUnion("success", [
  ToolResponseSuccessSchema,
  ToolResponseErrorSchema,
]);
export type ToolResponseBase = z.infer<typeof ToolResponseBaseSchema>;

// ---------------------------------------------------------------------------
// Aggregate transport message union
// ---------------------------------------------------------------------------

/**
 * Union of all top-level message types that can appear on the transport.
 * Useful for a single discriminated-union parse at the transport layer.
 */
export const TransportMessageSchema = z.discriminatedUnion("type", [
  HandshakeRequestSchema,
  HandshakeAckSchema,
  RpcEnvelopeSchema.extend({ type: z.literal("rpc") }),
]);
export type TransportMessage = z.infer<typeof TransportMessageSchema>;

// ---------------------------------------------------------------------------
// Re-exports from sub-modules
// ---------------------------------------------------------------------------

export * from "./handles.js";
export * from "./grants.js";
export * from "./rpc.js";
export * from "./rendering.js";
export * from "./trust-rules.js";
