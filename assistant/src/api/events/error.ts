/**
 * `error` SSE event.
 *
 * Terminal error for an assistant turn — emitted when generation fails
 * before a `message_complete`. Carries a human-readable `message` plus
 * optional machine-readable classification (`code`, `errorCategory`)
 * the client uses to pick contextual recovery UI, and `requestId` /
 * `conversationId` correlation ids.
 *
 * `message` is required: the daemon's emit sites always populate it.
 * `category` is a coarse contextual hint (e.g. `secret_blocked` →
 * "Send Anyway"); `errorCategory` is the finer machine-readable
 * classification used by billing/credit recovery banners.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
  category: z.string().optional(),
  errorCategory: z.string().optional(),
  requestId: z.string().optional(),
  conversationId: z.string().optional(),
});

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
