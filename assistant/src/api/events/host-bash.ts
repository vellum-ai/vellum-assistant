/**
 * Host-bash proxy SSE events (`host_bash_request` / `host_bash_cancel`).
 *
 * Server → client instructions that proxy shell commands to the desktop
 * client (host machine) when running as a managed assistant. The client
 * executes and POSTs the result back to `/v1/host-bash-result`;
 * `host_bash_cancel` withdraws an in-flight request. `targetClientId`
 * pins delivery to a single connected client.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const HostBashRequestEventSchema = z.object({
  type: z.literal("host_bash_request"),
  requestId: z.string(),
  conversationId: z.string(),
  command: z.string(),
  working_dir: z.string().optional(),
  timeout_seconds: z.number().optional(),
  /** Extra environment variables to inject into the subprocess (e.g. __CONVERSATION_ID). */
  env: z.record(z.string(), z.string()).optional(),
  /** When set, route this request only to the client with this ID. */
  targetClientId: z.string().optional(),
});

export type HostBashRequestEvent = z.infer<typeof HostBashRequestEventSchema>;

export const HostBashCancelEventSchema = z.object({
  type: z.literal("host_bash_cancel"),
  requestId: z.string(),
  conversationId: z.string(),
  /** When set, route this cancel only to the client that owns the request. */
  targetClientId: z.string().optional(),
});

export type HostBashCancelEvent = z.infer<typeof HostBashCancelEventSchema>;
