/**
 * Host computer-use proxy SSE events (`host_cu_request` / `host_cu_cancel`).
 *
 * Server → client instructions that proxy computer-use actions (click,
 * type, screenshot, …) to the desktop client when running as a managed
 * assistant. The client executes and POSTs the result back to
 * `/v1/host-cu-result`; `host_cu_cancel` withdraws an in-flight request.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const HostCuRequestEventSchema = z.object({
  type: z.literal("host_cu_request"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
  /** Tool name — "computer_use_click", "computer_use_type_text", etc. */
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  stepNumber: z.number(),
  reasoning: z.string().optional(),
});

export type HostCuRequestEvent = z.infer<typeof HostCuRequestEventSchema>;

export const HostCuCancelEventSchema = z.object({
  type: z.literal("host_cu_cancel"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
});

export type HostCuCancelEvent = z.infer<typeof HostCuCancelEventSchema>;
