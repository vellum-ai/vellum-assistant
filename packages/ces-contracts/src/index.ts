/**
 * @vellumai/ces-contracts
 *
 * Neutral wire-protocol contracts for communication between the assistant
 * daemon and the Credential Execution Service (CES). This package is
 * intentionally free of imports from `assistant/` or any CES implementation
 * module so that both sides can depend on it without circular references.
 */

import { z } from "zod/v4";

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
// RPC error
// ---------------------------------------------------------------------------

export const RpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Optional structured details for debugging. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

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
 * assistant.
 */
export const ToolResponseBaseSchema = z.object({
  /** Whether the tool executed successfully. */
  success: z.boolean(),
  /** Tool output when `success` is true. */
  result: z.unknown().optional(),
  /** Structured error when `success` is false. */
  error: RpcErrorSchema.optional(),
});
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
