/**
 * `platform_disconnected` SSE event.
 *
 * Emitted by the platform-disconnect route after stored platform
 * credentials are deleted, notifying connected clients that the platform
 * connection is gone.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const PlatformDisconnectedEventSchema = z.object({
  type: z.literal("platform_disconnected"),
});

export type PlatformDisconnectedEvent = z.infer<
  typeof PlatformDisconnectedEventSchema
>;
