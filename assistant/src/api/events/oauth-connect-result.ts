/**
 * `oauth_connect_result` SSE event.
 *
 * Emitted by the settings OAuth-connect route when a deferred OAuth flow
 * completes, so connected clients can reflect the new connection state
 * (or surface the failure) without re-fetching.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const OAuthConnectResultEventSchema = z.object({
  type: z.literal("oauth_connect_result"),
  success: z.boolean(),
  service: z.string().optional(),
  grantedScopes: z.array(z.string()).optional(),
  accountInfo: z.string().optional(),
  error: z.string().optional(),
});

export type OAuthConnectResultEvent = z.infer<
  typeof OAuthConnectResultEventSchema
>;
