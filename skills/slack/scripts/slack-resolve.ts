#!/usr/bin/env bun

/**
 * Resolve Slack channels and users by name, email, or ID.
 *
 * Usage:
 *   slack-resolve.ts channel <name-or-id>
 *   slack-resolve.ts user <name-or-email>
 *   slack-resolve.ts channels [--refresh]
 */

import { parseArgs, ok, printError } from "./lib/common.js";
import {
  resolveChannel,
  resolveUser,
  refreshChannelCache,
  loadCache,
  CHANNEL_CACHE_PATH,
} from "./lib/cache.js";
import type { SlackChannelCache } from "./lib/cache.js";

const subcommand = process.argv[2];
const target = process.argv[3];
const flags = parseArgs(process.argv.slice(3));

async function main(): Promise<void> {
  switch (subcommand) {
    case "channel": {
      if (!target) {
        printError("Usage: slack-resolve.ts channel <name-or-id>");
        return;
      }
      const result = await resolveChannel(target);
      ok({ id: result.id, name: result.name, type: result.type });
      break;
    }

    case "user": {
      if (!target) {
        printError("Usage: slack-resolve.ts user <name-or-email>");
        return;
      }
      const result = await resolveUser(target);
      ok({
        id: result.id,
        displayName: result.displayName,
        email: result.email,
      });
      break;
    }

    case "channels": {
      let cache: SlackChannelCache | null;
      if (flags.refresh === true) {
        cache = await refreshChannelCache();
      } else {
        cache = loadCache<SlackChannelCache>(CHANNEL_CACHE_PATH);
        if (!cache) {
          cache = await refreshChannelCache();
        }
      }
      ok({
        channels: Object.entries(cache.channels).map(([name, v]) => ({
          name,
          ...v,
        })),
      });
      break;
    }

    default:
      printError(
        `Unknown subcommand: ${subcommand ?? "(none)"}. Expected: channel, user, channels`,
      );
  }
}

try {
  await main();
} catch (err: unknown) {
  printError(err instanceof Error ? err.message : String(err));
}
