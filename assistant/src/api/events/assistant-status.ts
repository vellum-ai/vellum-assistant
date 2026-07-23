/**
 * `assistant_status` SSE event.
 *
 * Server → client status announcement carrying the daemon `version`
 * and, when present, the assistant's key `keyFingerprint`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AssistantStatusEventSchema = z.object({
  type: z.literal("assistant_status"),
  version: z.string().optional(),
  keyFingerprint: z.string().optional(),
});

export type AssistantStatusEvent = z.infer<typeof AssistantStatusEventSchema>;
