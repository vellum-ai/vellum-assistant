/**
 * Canonical schema + type for the targeting/suppression options accepted by the
 * assistant event hub's `publish`.
 *
 * Kept in its own module so both the in-process consumer (the hub's `publish`
 * signature) and the wire consumer (the `/events/publish` IPC route's param
 * validation) reuse one definition instead of drifting apart.
 */

import { z } from "zod";

import { HOST_PROXY_CAPABILITIES, INTERFACE_IDS } from "../channels/types.js";

export const AssistantEventPublishOptionsSchema = z.object({
  targetCapability: z.enum(HOST_PROXY_CAPABILITIES).optional(),
  targetClientId: z.string().optional(),
  targetInterfaceId: z.enum(INTERFACE_IDS).optional(),
  /**
   * Skip the subscriber with this `clientId`. Used for self-echo suppression on
   * `sync_changed`: the route handler echoes the originating tab's
   * `X-Vellum-Client-Id` back on the event, and the hub uses it here to avoid
   * re-delivering the invalidation to the tab that already mutated its own
   * optimistic state.
   */
  excludeClientId: z.string().optional(),
});

/** Targeting/suppression options for {@link AssistantEventHub.publish}. */
export type AssistantEventPublishOptions = z.infer<
  typeof AssistantEventPublishOptionsSchema
>;
