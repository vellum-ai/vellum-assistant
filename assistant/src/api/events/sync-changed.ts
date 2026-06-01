/**
 * `sync_changed` SSE event.
 *
 * The generic multi-client cache-invalidation contract. The daemon
 * broadcasts it after a persisted-state write succeeds; `tags` name
 * which cached resources are now stale (not their new values) so each
 * client refetches the affected endpoints. This is a global broadcast —
 * it carries no `conversationId`.
 *
 * `originClientId` is the opaque identifier of the client whose mutation
 * triggered the emission, when known. Consumers may use it to suppress
 * self-echoes (the originating tab already applied the change
 * optimistically). It is absent for daemon-internal emissions (agent
 * loop, FS watcher, schedules).
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const SyncChangedEventSchema = z.object({
  type: z.literal("sync_changed"),
  tags: z.array(z.string().min(1)).min(1),
  originClientId: z.string().min(1).optional(),
});

export type SyncChangedEvent = z.infer<typeof SyncChangedEventSchema>;
