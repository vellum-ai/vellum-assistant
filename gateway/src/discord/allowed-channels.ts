/**
 * The admitted-channel allow-list, read from `config.json`.
 *
 * This is a named module rather than an inline read at the construction site
 * so the config-to-set conversion is reachable from a test. It stays out of
 * `admit.ts` because that module is a pure function over the fields it reads,
 * and reading configuration is I/O.
 */

import type { ConfigFileCache } from "../config-file-cache.js";

/**
 * Read the channel snowflakes the bot may act in.
 *
 * Accepts both shapes the setting is authored in (a JSON array or a
 * comma-separated string) because {@link ConfigFileCache.getStringArray}
 * normalizes them. An absent, malformed, or empty setting yields an empty set,
 * which the gate treats as admitting nothing. Being invited to a guild is not
 * consent to every channel in it, so the fail-closed direction is the safe
 * one.
 */
export function readDiscordAllowedChannelIds(
  configFileCache: ConfigFileCache,
): Set<string> {
  return new Set(
    configFileCache.getStringArray("discord", "allowedChannelIds") ?? [],
  );
}
