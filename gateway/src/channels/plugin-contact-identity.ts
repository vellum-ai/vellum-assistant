import { canonicalizeIdentityAs } from "../verification/identity.js";
import { pluginScopedId } from "./plugin-inbound.js";
import { isChannelId } from "./types.js";

/**
 * True when `type` is a plugin directory name the Contacts page lists
 * (`imessage`, `meeting-bot`), not a built-in channel id.
 *
 * Inbound trust is stored as `(plugin, ${plugin}:${address})`. A row the
 * Contacts page keys as `imessage` / `+15550100` is not the row the
 * admission floor looks up, so verifying one has to write that inbound twin.
 */
export function isPluginDiscoveredChannelType(type: string): boolean {
  return type.length > 0 && !isChannelId(type);
}

/**
 * The address inbound trust resolution uses for a plugin-discovered
 * channel: the plugin name, then the canonical vendor id.
 *
 * Phone-shaped addresses become E.164 before the prefix, matching
 * `readPluginInbound` (canonicalize, then scope). Handles that are not
 * phone numbers stay trimmed.
 */
export function pluginInboundAddress(
  plugin: string,
  address: string,
): string | null {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const canonical = canonicalizeIdentityAs("phone", trimmed);
  if (!canonical) {
    return null;
  }
  return pluginScopedId(plugin, canonical);
}

/**
 * Append the inbound twin for each plugin-discovered channel so a Contacts
 * upsert of `imessage` / `+15550100` also writes `plugin` /
 * `imessage:+15550100`.
 *
 * Twin rows omit any caller-supplied `id` so they never share the
 * discovered row's primary key.
 */
export function expandPluginChannelTwins<
  T extends { type: string; address: string; id?: string },
>(channels: T[]): T[] {
  const extras: T[] = [];
  for (const channel of channels) {
    if (!isPluginDiscoveredChannelType(channel.type)) {
      continue;
    }
    const scoped = pluginInboundAddress(channel.type, channel.address);
    if (!scoped) {
      continue;
    }
    extras.push({ ...channel, id: undefined, type: "plugin", address: scoped });
  }
  if (extras.length === 0) {
    return channels;
  }
  return [...channels, ...extras];
}
