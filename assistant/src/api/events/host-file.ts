/**
 * Host-file proxy SSE events (`host_file_request` / `host_file_cancel`).
 *
 * Server → client instructions that proxy file operations (read / write /
 * edit) to the desktop client when running as a managed assistant. The
 * request is a discriminated union on `operation`; the client executes it
 * and POSTs the result back to `/v1/host-file-result`. `host_file_cancel`
 * withdraws an in-flight request.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

const HostFileReadRequestSchema = z.object({
  type: z.literal("host_file_request"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
  operation: z.literal("read"),
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const HostFileWriteRequestSchema = z.object({
  type: z.literal("host_file_request"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
  operation: z.literal("write"),
  path: z.string(),
  content: z.string(),
});

const HostFileEditRequestSchema = z.object({
  type: z.literal("host_file_request"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
  operation: z.literal("edit"),
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export const HostFileRequestEventSchema = z.discriminatedUnion("operation", [
  HostFileReadRequestSchema,
  HostFileWriteRequestSchema,
  HostFileEditRequestSchema,
]);

export type HostFileRequestEvent = z.infer<typeof HostFileRequestEventSchema>;

export const HostFileCancelEventSchema = z.object({
  type: z.literal("host_file_cancel"),
  requestId: z.string(),
  conversationId: z.string(),
  targetClientId: z.string().optional(),
});

export type HostFileCancelEvent = z.infer<typeof HostFileCancelEventSchema>;
