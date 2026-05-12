/**
 * Route handler for channel availability.
 *
 * GET /v1/channels/available — return the channels this assistant can
 * surface to clients (Contacts / GuardianChannels views, etc.). Today
 * this is a fixed base list plus `email` when an inbox is registered.
 * Eventually the list will be driven by plugins/skills the assistant has
 * loaded; clients should treat the response as authoritative and stop
 * carrying their own hardcoded list.
 *
 * Distinct from `/v1/channels/readiness` (which answers "is this channel
 * configured and working?"). Availability answers "could this channel be
 * surfaced for setup/verification at all?".
 */

import { z } from "zod";

import { CHANNEL_IDS, type ChannelId } from "../../channels/types.js";
import { VellumPlatformClient } from "../../platform/client.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// Base list every assistant currently surfaces. Order is the display
// order clients should render. Keep stable — clients sort by index.
const BASE_AVAILABLE_CHANNELS: readonly ChannelId[] = [
  "slack",
  "telegram",
  "phone",
] as const;

interface EmailAddressListResponse {
  count?: number;
  results?: Array<{ id: string; address: string }>;
}

/**
 * Best-effort check that an inbox address is registered for this
 * assistant. A platform fetch failure is treated as "no inbox" — we
 * prefer to under-report than block the entire Contacts page when the
 * platform is briefly unreachable.
 */
async function hasRegisteredInbox(): Promise<boolean> {
  const client = await VellumPlatformClient.create();
  if (!client?.platformAssistantId) {
    return false;
  }

  try {
    const response = await client.fetch(
      `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
    );
    if (!response.ok) {
      return false;
    }
    const data = (await response.json()) as EmailAddressListResponse;
    if (typeof data.count === "number") {
      return data.count > 0;
    }
    return Array.isArray(data.results) && data.results.length > 0;
  } catch {
    return false;
  }
}

async function handleGetChannelAvailability(_args: RouteHandlerArgs) {
  const channels: ChannelId[] = [...BASE_AVAILABLE_CHANNELS];
  if (await hasRegisteredInbox()) {
    channels.push("email");
  }
  return { success: true, channels };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "channels_available_get",
    endpoint: "channels/available",
    method: "GET",
    summary: "Get available channels",
    description:
      "Return the channel ids this assistant can surface to clients. " +
      "Today this is a fixed base list plus `email` when an inbox is " +
      "registered; will become plugin/skill-driven in future.",
    tags: ["channels"],
    requirePolicyEnforcement: true,
    handler: handleGetChannelAvailability,
    responseBody: z.object({
      success: z.boolean(),
      channels: z
        .array(z.enum(CHANNEL_IDS))
        .describe("Channel ids in display order"),
    }),
  },
];
