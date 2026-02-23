import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import type { RoutingOutcome } from "./types.js";

const log = getLogger("routing");

export function resolveAssistant(
  config: GatewayConfig,
  chatId: string,
  userId: string,
): RoutingOutcome {
  // Priority 1: explicit chat_id route
  for (const entry of config.routingEntries) {
    if (entry.type === "chat_id" && entry.key === chatId) {
      log.debug({ chatId, assistantId: entry.assistantId }, "Resolved by chat_id");
      return { assistantId: entry.assistantId, routeSource: "chat_id" };
    }
  }

  // Priority 2: explicit user_id route
  for (const entry of config.routingEntries) {
    if (entry.type === "user_id" && entry.key === userId) {
      log.debug({ userId, assistantId: entry.assistantId }, "Resolved by user_id");
      return { assistantId: entry.assistantId, routeSource: "user_id" };
    }
  }

  // Priority 3: apply unmapped policy
  if (config.unmappedPolicy === "default" && config.defaultAssistantId) {
    log.debug(
      { chatId, userId, assistantId: config.defaultAssistantId },
      "Resolved by default policy",
    );
    return { assistantId: config.defaultAssistantId, routeSource: "default" };
  }

  log.info({ chatId, userId }, "No route matched, rejecting");
  return { rejected: true, reason: "No route configured for this chat" };
}

/**
 * Resolve the assistant by looking up the inbound "To" phone number in
 * the per-assistant phone number mapping. Returns undefined when no match
 * is found, letting callers fall through to the standard routing chain.
 */
export function resolveAssistantByPhoneNumber(
  config: GatewayConfig,
  toNumber: string,
): RoutingOutcome | undefined {
  const mapping = config.assistantPhoneNumbers;
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
