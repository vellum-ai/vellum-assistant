/**
 * `service_group_update_starting` SSE event.
 *
 * Server → client broadcast that a service-group update is about to
 * begin. Carries the `targetVersion` being upgraded to and the
 * `expectedDowntimeSeconds` estimate so clients can surface a
 * countdown / maintenance affordance before the daemon restarts.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ServiceGroupUpdateStartingEventSchema = z
  .object({
    type: z.literal("service_group_update_starting"),
    /** The version being upgraded to. */
    targetVersion: z.string(),
    /** Estimated seconds of downtime. */
    expectedDowntimeSeconds: z.number(),
  })
  .strict();

export type ServiceGroupUpdateStartingEvent = z.infer<
  typeof ServiceGroupUpdateStartingEventSchema
>;
