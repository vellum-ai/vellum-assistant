/**
 * The admitted-channel allow-list, read from `config.json`.
 *
 * This lives in its own module rather than inline at the construction site so
 * the config read is reachable from a test. The seam between the stored value
 * and the set handed to the admission gate is exactly where an array-shaped
 * allow-list collapsed to empty, and an arrow function buried in the server
 * bootstrap cannot be exercised by anything.
 *
 * It stays out of `admit.ts` because that module is a pure function over the
 * fields it reads. Reading configuration is I/O, and mixing the two is what
 * left the gate fully unit-tested while the value feeding it was never
 * exercised at all.
 */

import type { ConfigFileCache } from "../config-file-cache.js";

/**
 * Read the channel snowflakes the bot may act in.
 *
 * Accepts both shapes the setting is authored in (a JSON array or a
 * comma-separated string) because {@link ConfigFileCache.getStringArray}
 * normalizes them. An absent, malformed, or empty setting yields an empty set,
 * which the gate treats as admitting nothing. That is deliberate: being
 * invited to a guild is not consent to every channel in it, so the fail-closed
 * direction is the safe one.
 */
export function readDiscordAllowedChannelIds(
  configFileCache: ConfigFileCache,
): Set<string> {
  return new Set(
    configFileCache.getStringArray("discord", "allowedChannelIds") ?? [],
  );
}
