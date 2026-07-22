/**
 * `service_group_update_progress` SSE event.
 *
 * Server → client broadcast carrying a short, user-friendly
 * `statusMessage` describing the current step of an in-flight update
 * or rollback. Emitted repeatedly as the update advances.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ServiceGroupUpdateProgressEventSchema = z
  .object({
    type: z.literal("service_group_update_progress"),
    /** A short, user-friendly status message describing what's happening right now. */
    statusMessage: z.string(),
  })
  .strict();

export type ServiceGroupUpdateProgressEvent = z.infer<
  typeof ServiceGroupUpdateProgressEventSchema
>;
