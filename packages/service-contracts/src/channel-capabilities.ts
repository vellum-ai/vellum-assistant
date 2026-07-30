/**
 * Channel capability annotations, read off the address schemas.
 *
 * What a consumer needs to know about a channel before it can address one is
 * already stated by that channel's `ChannelAddress` variant: whether identity
 * is namespaced by a provider account, which scope coordinates exist, which of
 * them are required, and which coordinates name the peer. Restating any of it
 * in a hand-maintained table would create a second classifier that drifts from
 * the schemas the moment one side is edited alone, so this module reflects the
 * schemas instead and holds no per-channel data of its own.
 *
 * The annotations are built by walking `CHANNEL_IDS`, so a channel added to the
 * canonical vocabulary without an address variant fails at import rather than
 * silently annotating as unscoped with no coordinates.
 */

import { z } from "zod";

import { CHANNEL_ADDRESS_SCHEMAS } from "./channel-address.js";
import { CHANNEL_IDS, type ChannelId } from "./channels.js";

/** What a channel's address shape says about how the channel is addressed. */
export interface ChannelAddressCapabilities {
  readonly channel: ChannelId;
  /**
   * Whether identity on this channel is namespaced by a provider account or
   * installation. A Slack user id means nothing without its workspace; a phone
   * number means the same thing everywhere.
   */
  readonly accountScoped: boolean;
  /** Scope coordinate names, alphabetical. Empty when the channel is not scoped. */
  readonly scopeCoordinates: readonly string[];
  /**
   * Scope coordinates a producer must always supply, alphabetical. A scope
   * coordinate outside this list exists only on some installations (Slack's
   * enterprise id, which only Enterprise Grid has).
   */
  readonly requiredScopeCoordinates: readonly string[];
  /** Coordinate names identifying the peer itself, alphabetical. */
  readonly identityCoordinates: readonly string[];
}

/**
 * Widened view of the variant map. The narrow `as const` type carries each
 * channel's exact schema, which is what makes the exhaustiveness gate work, but
 * reflection wants the common `ZodObject` surface.
 */
const VARIANTS: Readonly<Record<ChannelId, z.ZodObject>> =
  CHANNEL_ADDRESS_SCHEMAS;

function objectField(shape: z.ZodRawShape, key: string): z.ZodObject | null {
  const field = shape[key];
  return field instanceof z.ZodObject ? field : null;
}

function sortedKeys(shape: z.ZodRawShape): readonly string[] {
  return Object.keys(shape).sort();
}

function requiredKeys(shape: z.ZodRawShape): readonly string[] {
  return sortedKeys(shape).filter(
    (key) => !(shape[key] instanceof z.ZodOptional),
  );
}

function describe(channel: ChannelId): ChannelAddressCapabilities {
  const variant: z.ZodObject | undefined = VARIANTS[channel];
  if (variant === undefined) {
    throw new Error(
      `channel "${channel}" has no address variant; add one to CHANNEL_ADDRESS_SCHEMAS`,
    );
  }

  const scope = objectField(variant.shape, "scope");
  const coordinates = objectField(variant.shape, "coordinates");
  if (coordinates === null) {
    throw new Error(
      `channel "${channel}" has no address coordinates; every canonical channel needs an explicit address shape`,
    );
  }

  return {
    channel,
    accountScoped: scope !== null,
    scopeCoordinates: scope ? sortedKeys(scope.shape) : [],
    requiredScopeCoordinates: scope ? requiredKeys(scope.shape) : [],
    identityCoordinates: sortedKeys(coordinates.shape),
  };
}

/** Capability annotations for every canonical channel, derived at import. */
export const CHANNEL_ADDRESS_CAPABILITIES: ReadonlyMap<
  ChannelId,
  ChannelAddressCapabilities
> = new Map(CHANNEL_IDS.map((channel) => [channel, describe(channel)]));

/** Capability annotations for one channel. */
export function channelAddressCapabilities(
  channel: ChannelId,
): ChannelAddressCapabilities {
  const capabilities = CHANNEL_ADDRESS_CAPABILITIES.get(channel);
  if (capabilities === undefined) {
    throw new Error(`channel "${channel}" has no derived address capabilities`);
  }
  return capabilities;
}

/** Channels whose identity is namespaced by a provider account or installation. */
export function accountScopedChannels(): readonly ChannelId[] {
  return CHANNEL_IDS.filter(
    (channel) => channelAddressCapabilities(channel).accountScoped,
  );
}
