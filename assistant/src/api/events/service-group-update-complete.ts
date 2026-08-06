/**
 * `service_group_update_complete` SSE event.
 *
 * Server → client broadcast that a service-group update has finished.
 * `installedVersion` is the version now running (may differ from the
 * originally targeted version if the update rolled back), `success`
 * flags whether the update applied or reverted, and
 * `rolledBackToVersion` names the reverted-to version when it did.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ServiceGroupUpdateCompleteEventSchema = z.object({
  type: z.literal("service_group_update_complete"),
  /** The version that was installed (may differ from target if rolled back). */
  installedVersion: z.string(),
  /** Whether the update succeeded or rolled back. */
  success: z.boolean(),
  /** If rolled back, the version reverted to. */
  rolledBackToVersion: z.string().optional(),
});

export type ServiceGroupUpdateCompleteEvent = z.infer<
  typeof ServiceGroupUpdateCompleteEventSchema
>;
