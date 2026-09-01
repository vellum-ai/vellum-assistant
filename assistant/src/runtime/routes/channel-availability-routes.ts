/**
 * Route handler for channel availability.
 *
 * GET /v1/channels/available — return the channels this assistant can
 * surface to clients (Contacts / GuardianChannels views, etc.) along with
 * their display metadata (label, subtitle, icon, verification capability,
 * setup-message copy). A fixed base list, plus `email` when an inbox is
 * registered, plus the channels installed plugins bring by declaring
 * ingress. One list, because a plugin channel is a channel; each row's
 * `source` says who contributes it. Clients should treat the response as
 * authoritative and stop carrying their own per-channel switches.
 *
 * Distinct from `/v1/channels/readiness` (which answers "is this channel
 * configured and working?"). Availability answers "could this channel be
 * surfaced for setup/verification at all?".
 */

import { z } from "zod";

import { isA2AEnabled } from "../../a2a/feature-gate.js";
import { discoverPluginChannels } from "../../channels/plugin-channel-declarations.js";
import {
  type AvailableChannel,
  CHANNEL_METADATA,
  type ChannelId,
  type ChannelInfo,
} from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import { resolveConfiguredByoEmailService } from "../../email/byo-email-credential.js";
import { resolveRegisteredInbox } from "../../email/registered-inbox.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// Base list every assistant currently surfaces. Order is the display
// order clients should render. Keep stable — clients sort by index.
const BASE_AVAILABLE_CHANNELS: readonly ChannelId[] = [
  "slack",
  "telegram",
  "discord",
  "phone",
] as const;

/**
 * Best-effort check that email is configured for this assistant: a managed
 * inbox registered on the platform, or a "your own" provider credential
 * (whose gateway webhook routes carry inbound just as the managed pipeline
 * does). An unavailable platform is treated as "no inbox": we prefer to
 * under-report than block the entire Contacts page when the platform is
 * briefly unreachable.
 *
 * Fresh, preserving this route's long-standing live-read-per-request
 * behavior: availability is fetched on surface loads, not on a poll, so it
 * does not need the resolver's cache and should not inherit its staleness.
 */
async function hasConfiguredEmail(): Promise<boolean> {
  const inbox = await resolveRegisteredInbox({ fresh: true });
  if (inbox.status === "registered") {
    return true;
  }
  return (await resolveConfiguredByoEmailService()) !== undefined;
}

async function handleGetChannelAvailability(
  _args: RouteHandlerArgs,
): Promise<{ channels: AvailableChannel[] }> {
  const ids: ChannelId[] = [...BASE_AVAILABLE_CHANNELS];
  if (await hasConfiguredEmail()) {
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
  const builtIn: AvailableChannel[] = ids
    .map((id) => CHANNEL_METADATA[id])
    .filter((info): info is ChannelInfo => info !== undefined)
    .map((info) => ({ ...info, source: "default" as const }));
  // One list, because a plugin channel is a channel: what differs is who
  // contributes it, which is what `source` says. Built-ins lead, so a client
  // rendering in order gets a stable list that plugin installs append to.
  return { channels: [...builtIn, ...(await discoverPluginChannels())] };
}

const channelInfoSchema = z.object({
  // A string rather than the channel enum: a plugin channel's id is its
  // plugin name, and `source` is what says which kind a row is.
  id: z.string(),
  source: z
    .string()
    .describe(
      "`default` for a channel the assistant ships, `plugin:<name>` for one " +
        "an installed plugin brings",
    ),
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
      "copy). A fixed base list plus `email` when an inbox is registered, " +
      "plus the channels installed plugins bring by declaring ingress " +
      "routes. Each carries a `source` saying which of those it is.",
    tags: ["channels"],
    handler: handleGetChannelAvailability,
    responseBody: z.object({
      channels: z
        .array(channelInfoSchema)
        .describe(
          "Available channels in display order: the ones the assistant " +
            "ships, then the ones installed plugins bring by declaring " +
            "ingress routes. `source` distinguishes them.",
        ),
    }),
  },
];
