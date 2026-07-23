/**
 * Host-transfer proxy SSE events (`host_transfer_request` /
 * `host_transfer_cancel`).
 *
 * Server → client instructions that proxy bidirectional file transfer
 * between the sandbox and the host machine. The request is a discriminated
 * union on `direction` (`to_host` uploads to the host; `to_sandbox` pulls a
 * host file into the sandbox). `host_transfer_cancel` withdraws an in-flight
 * request.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

const HostTransferToHostRequestSchema = z.object({
  type: z.literal("host_transfer_request"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
  direction: z.literal("to_host"),
  transferId: z.string(),
  destPath: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  overwrite: z.boolean(),
});

const HostTransferToSandboxRequestSchema = z.object({
  type: z.literal("host_transfer_request"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
  direction: z.literal("to_sandbox"),
  transferId: z.string(),
  sourcePath: z.string(),
});

export const HostTransferRequestEventSchema = z.discriminatedUnion(
  "direction",
  [HostTransferToHostRequestSchema, HostTransferToSandboxRequestSchema],
);

export type HostTransferRequestEvent = z.infer<
  typeof HostTransferRequestEventSchema
>;

export const HostTransferCancelEventSchema = z.object({
  type: z.literal("host_transfer_cancel"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
});

export type HostTransferCancelEvent = z.infer<
  typeof HostTransferCancelEventSchema
>;
