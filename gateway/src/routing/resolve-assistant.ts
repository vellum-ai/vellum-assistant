import type { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import type { RoutingOutcome } from "./types.js";

const log = getLogger("routing");

export function resolveAssistant(
  config: GatewayConfig,
  conversationId: string,
  actorId: string,
): RoutingOutcome {
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

  // Priority 3: apply unmapped policy
  if (config.unmappedPolicy === "default" && config.defaultAssistantId) {
    log.debug(
      { conversationId, actorId, assistantId: config.defaultAssistantId },
      "Resolved by default policy",
    );
    return { assistantId: config.defaultAssistantId, routeSource: "default" };
  }

  log.info({ conversationId, actorId }, "No route matched, rejecting");
  return { rejected: true, reason: "No route configured for this chat" };
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
