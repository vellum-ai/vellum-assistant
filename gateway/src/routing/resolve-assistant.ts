import { LOCAL_ASSISTANT_ID } from "../assistant-id.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import type { RoutingOutcome } from "./types.js";

const log = getLogger("routing");

export function resolveAssistant(
  config: GatewayConfig,
  conversationId: string | undefined,
  actorId: string | undefined,
): RoutingOutcome {
  // Priority 0: no identity at all → nothing to route on, so a malformed event
  // with neither a conversation nor an actor is dropped rather than attributed
  // to the local assistant. This is the only rejection this function produces;
  // callers are expected to validate identity too, and this is the fail-closed
  // backstop behind them.
  if (!conversationId && !actorId) {
    log.info(
      { conversationId, actorId },
      "No routable identity on event, rejecting",
    );
    return { rejected: true, reason: "No routable identity on this event" };
  }

  // Priority 1: explicit conversation_id route
  for (const entry of config.routingEntries) {
    if (entry.type === "conversation_id" && entry.key === conversationId) {
      log.debug(
        { conversationId, assistantId: entry.assistantId },
        "Resolved by conversation_id",
      );
      return { assistantId: entry.assistantId, routeSource: "conversation_id" };
    }
  }

  // Priority 2: explicit actor_id route
  for (const entry of config.routingEntries) {
    if (entry.type === "actor_id" && entry.key === actorId) {
      log.debug(
        { actorId, assistantId: entry.assistantId },
        "Resolved by actor_id",
      );
      return { assistantId: entry.assistantId, routeSource: "actor_id" };
    }
  }

  // Priority 3: the local assistant. A gateway process fronts exactly one
  // daemon, so any event carrying a routable identity belongs to it — there is
  // no second backend an unmatched event could have been meant for. Admission
  // is decided downstream on trust class (see the admission-policy floor in
  // gateway/CLAUDE.md), not here on whether a routing entry happened to exist.
  log.debug(
    { conversationId, actorId, assistantId: LOCAL_ASSISTANT_ID },
    "Resolved to the local assistant",
  );
  return { assistantId: LOCAL_ASSISTANT_ID, routeSource: "default" };
}

/**
 * Resolve the assistant by looking up the inbound "To" phone number in
 * the per-assistant phone number mapping. Returns undefined when no match
 * is found, letting callers fall through to the standard routing chain.
 *
 * Reads the mapping from ConfigFileCache when available.
 */
export function resolveAssistantByPhoneNumber(
  _config: GatewayConfig,
  toNumber: string,
  configFileCache?: ConfigFileCache,
): RoutingOutcome | undefined {
  const mapping = configFileCache?.getRecord("twilio", "assistantPhoneNumbers");
  if (!mapping) return undefined;

  // Reverse lookup: the mapping is assistantId -> phoneNumber, so we need
  // to find the assistantId whose value matches the inbound "To" number.
  for (const [assistantId, phoneNumber] of Object.entries(mapping)) {
    if (phoneNumber === toNumber) {
      log.debug({ toNumber, assistantId }, "Resolved by phone number");
      return { assistantId, routeSource: "phone_number" };
    }
  }

  return undefined;
}

export function isRejection(
  outcome: RoutingOutcome,
): outcome is { rejected: true; reason: string } {
  return "rejected" in outcome && outcome.rejected === true;
}
