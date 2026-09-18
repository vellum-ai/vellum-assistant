/**
 * Who receives a targeted assistant event. Live fanout
 * (`AssistantEventHub.publish`) and replay (`getReplayWindow`, reached from
 * the SSE reconnect and the `events/tail` route) both decide delivery with
 * {@link matchesTargeting}, so a targeting rule added here reaches every
 * path at once.
 *
 * Conversation scoping is deliberately not part of this check. Live fanout
 * applies a subscriber's conversation filter only to events that do not name
 * a client; replay scopes to the conversation its caller asked for. Each path
 * applies its own scoping after this check.
 */

import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import type { AssistantEventPublishOptions } from "./assistant-event-publish-options.js";

/** The connection an event is being delivered to, live or on replay. */
export interface SubscriberIdentity {
  type: "client" | "process";
  clientId?: string;
  interfaceId?: InterfaceId;
  capabilities?: readonly HostProxyCapability[];
  actorPrincipalId?: string;
}

/**
 * Whether `subscriber` receives an event carrying `targeting`. An event with
 * no targeting reaches every subscriber. Every rule a targeted event sets must
 * hold, and a process subscriber never matches a rule that names a client
 * property.
 */
export function matchesTargeting(
  targeting: AssistantEventPublishOptions | undefined,
  subscriber: SubscriberIdentity,
): boolean {
  if (!targeting) {
    return true;
  }
  const isClient = subscriber.type === "client";

  // Self-echo suppression: the client that originated a mutation does not
  // receive its own invalidation back.
  if (
    targeting.excludeClientId != null &&
    isClient &&
    subscriber.clientId === targeting.excludeClientId
  ) {
    return false;
  }
  if (
    targeting.targetInterfaceId != null &&
    (!isClient || subscriber.interfaceId !== targeting.targetInterfaceId)
  ) {
    return false;
  }
  // An event scoped to one person reaches only that person's connections; a
  // connection with no verified principal never matches.
  if (
    targeting.targetActorPrincipalId != null &&
    (!isClient ||
      subscriber.actorPrincipalId !== targeting.targetActorPrincipalId)
  ) {
    return false;
  }
  if (
    targeting.targetClientId != null &&
    (!isClient || subscriber.clientId !== targeting.targetClientId)
  ) {
    return false;
  }
  if (
    targeting.targetCapability != null &&
    (!isClient ||
      !subscriber.capabilities?.includes(targeting.targetCapability))
  ) {
    return false;
  }
  return true;
}
