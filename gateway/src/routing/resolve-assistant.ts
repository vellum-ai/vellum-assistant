import { LOCAL_ASSISTANT_ID } from "../assistant-id.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import type { RouteResult } from "./types.js";

const log = getLogger("routing");

/**
 * The route every identified inbound event takes.
 *
 * A gateway process fronts exactly one daemon at a fixed
 * `assistantRuntimeBaseUrl`, and the inbound wire payload carries no assistant
 * id, so routing has nothing left to choose. Whether a sender is allowed
 * through is a separate decision made downstream against the channel's
 * admission floor — see "Channel Trust Classification & Admission Policy" in
 * gateway/CLAUDE.md.
 */
export const LOCAL_ROUTE: RouteResult = Object.freeze({
  assistantId: LOCAL_ASSISTANT_ID,
  routeSource: "default",
});

/**
 * Fail-closed identity backstop.
 *
 * An event carrying neither a conversation nor an actor id has nothing to bind
 * a conversation on and nothing to classify trust against, so it is dropped
 * rather than attributed to the local assistant. Ingress handlers validate the
 * identity fields they key on as well; this is the shared rule behind them.
 */
export function hasRoutableIdentity(
  conversationId: string | undefined,
  actorId: string | undefined,
): boolean {
  if (conversationId || actorId) return true;
  log.info(
    { conversationId, actorId },
    "No routable identity on event, dropping",
  );
  return false;
}

/**
 * Resolve the assistant by looking up the inbound "To" phone number in
 * the per-assistant phone number mapping. Returns undefined when no match
 * is found, letting callers fall through to {@link LOCAL_ROUTE}.
 *
 * Reads the mapping from ConfigFileCache when available.
 */
export function resolveAssistantByPhoneNumber(
  _config: GatewayConfig,
  toNumber: string,
  configFileCache?: ConfigFileCache,
): RouteResult | undefined {
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
