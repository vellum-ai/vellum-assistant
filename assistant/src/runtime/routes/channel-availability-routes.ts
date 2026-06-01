/**
 * Route handler for channel availability.
 *
 * GET /v1/channels/available — return the channels this assistant can
 * surface to clients (Contacts / GuardianChannels views, etc.) along with
 * their display metadata (label, subtitle, icon, verification capability,
 * setup-message copy). Today this is a fixed base list plus `email` when
 * an inbox is registered; eventually the list will be driven by
 * plugins/skills the assistant has loaded. Clients should treat the
 * response as authoritative and stop carrying their own per-channel
 * switches.
 *
 * Distinct from `/v1/channels/readiness` (which answers "is this channel
 * configured and working?"). Availability answers "could this channel be
 * surfaced for setup/verification at all?".
 */

import { z } from "zod";

import { isA2AEnabled } from "../../a2a/feature-gate.js";
import {
  CHANNEL_IDS,
  CHANNEL_METADATA,
  type ChannelId,
  type ChannelInfo,
} from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import { VellumPlatformClient } from "../../platform/client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
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

async function handleGetChannelAvailability(
  _args: RouteHandlerArgs,
): Promise<{ channels: ChannelInfo[] }> {
  const ids: ChannelId[] = [...BASE_AVAILABLE_CHANNELS];
  if (await hasRegisteredInbox()) {
    ids.push("email");
  }
  if (isA2AEnabled(getConfig())) {
    ids.push("a2a");
  }
  // CHANNEL_METADATA is `Partial<Record<ChannelId, ChannelInfo>>` because
  // unsurfaced channels deliberately have no metadata. `ids` only ever
  // contains channels that BASE_AVAILABLE_CHANNELS / the email branch
  // explicitly chose, so the lookup is always defined — filter to satisfy
  // the type system without a non-null assertion.
  const channels = ids
    .map((id) => CHANNEL_METADATA[id])
    .filter((info): info is ChannelInfo => info !== undefined);
  return { channels };
}

const channelInfoSchema = z.object({
  id: z.enum(CHANNEL_IDS),
  label: z.string(),
  subtitle: z.string(),
  icon: z.string(),
  supportsVerification: z.boolean(),
  setupMessages: z.object({
    guardian: z.string(),
    contact: z.string(),
  }),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "channels_available_get",
    endpoint: "channels/available",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get available channels",
    description:
      "Return the channels this assistant can surface to clients, with " +
      "display metadata (label, icon, verification capability, setup " +
      "copy). Today this is a fixed base list plus `email` when an inbox " +
      "is registered; will become plugin/skill-driven in future.",
    tags: ["channels"],
    handler: handleGetChannelAvailability,
    responseBody: z.object({
      channels: z
        .array(channelInfoSchema)
        .describe("Available channels in display order"),
    }),
  },
];
