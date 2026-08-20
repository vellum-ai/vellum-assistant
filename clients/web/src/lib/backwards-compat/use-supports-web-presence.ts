/**
 * Backwards-compat gate: the web-presence POST route.
 *
 * Old behavior (< MIN_VERSION): the assistant does not expose
 * `POST /v1/assistants/{assistant_id}/clients/web-presence`. The web client
 * must not send mount, lifecycle-edge, focused-conversation, SSE-reopen, or
 * reconciliation reports because those requests would 404 on older
 * assistants.
 *
 * New behavior (>= MIN_VERSION): the route records the browser tab's current
 * visibility and focused conversation so the daemon can suppress a redundant
 * APNs push for a reply already visible in that conversation.
 *
 * The floor is the exact dev build containing the route, rather than a
 * predicted release number. The hook uses the assistant-scoped gate so a
 * version hydrated for a different assistant cannot authorize writes to this
 * one, and remains conservatively disabled while identity is unknown.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.4-dev.202608192259.e726ce0";

/**
 * Returns whether `ownerAssistantId` supports the web-presence report route.
 * Unknown versions and identity-owner mismatches return `false`.
 */
export function useSupportsWebPresence(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
