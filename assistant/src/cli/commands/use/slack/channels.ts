import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../../ipc/cli-client.js";
import { getCliLogger } from "../../../logger.js";
import { shouldOutputJson, writeOutput } from "../../../output.js";

const log = getCliLogger("use:slack:channels");

interface ChannelCache {
  channels: Record<string, { id: string; type: string }>;
  refreshedAt: string;
}

interface ChannelEntry {
  id: string;
  name: string;
  type: string;
}

export function registerChannelsCommand(slack: Command): void {
  const channels = slack
    .command("channels")
    .description("List, refresh, or look up Slack channels");

  channels.addHelpText(
    "after",
    `
Manage the local Slack channel cache. Channels are cached locally after
the first fetch to avoid repeated API calls. Use 'refresh' to rebuild
the cache from the Slack API.

Examples:
  $ assistant use slack channels list
  $ assistant use slack channels refresh
  $ assistant use slack channels get team-jarvis`,
  );

  channels
    .command("list")
    .description("List cached Slack channels")
    .addHelpText(
      "after",
      `
Returns the locally cached channel list. If the cache is empty, it is
auto-populated from the Slack API on first call.

Examples:
  $ assistant use slack channels list
  general        C01234567  channel
  team-jarvis    C01234568  channel
  random         C01234569  channel

  $ assistant use slack channels list --json
  {"channels":{"general":{"id":"C01234567","type":"channel"},...},"refreshedAt":"..."}`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<ChannelCache>("slack_use_channels_list", {});
      if (!r.ok) return exitFromIpcResult(r, cmd);

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, r.result);
      } else {
        const cache = r.result!;
        const entries = Object.entries(cache.channels);
        if (entries.length === 0) {
          log.info("No channels found.");
        } else {
          // Find the longest channel name for alignment
          const maxName = Math.max(...entries.map(([name]) => name.length));
          for (const [name, info] of entries) {
            log.info(`${name.padEnd(maxName + 2)} ${info.id}  ${info.type}`);
          }
          log.info(
            `\n${entries.length} channel(s) (cached at ${cache.refreshedAt})`,
          );
        }
      }
    });

  channels
    .command("refresh")
    .description("Rebuild the local channel cache from the Slack API")
    .addHelpText(
      "after",
      `
Fetches all channels from the Slack API and rebuilds the local cache.
Use this after channels are created or renamed in Slack.

Examples:
  $ assistant use slack channels refresh
  Refreshed 42 channels

  $ assistant use slack channels refresh --json
  {"channels":{...},"refreshedAt":"..."}`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<ChannelCache>(
        "slack_use_channels_refresh",
        {},
      );
      if (!r.ok) return exitFromIpcResult(r, cmd);

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, r.result);
      } else {
        const count = Object.keys(r.result!.channels).length;
        log.info(`Refreshed ${count} channel(s)`);
      }
    });

  channels
    .command("get <name>")
    .description("Resolve a Slack channel by name or ID")
    .addHelpText(
      "after",
      `
Arguments:
  name   Channel name (e.g. "general", "#team-jarvis") or raw Slack channel ID

Resolves a channel name or ID to a structured object with the channel's
Slack ID, name, and type. Uses the local cache, auto-refreshing if needed.

Examples:
  $ assistant use slack channels get general
  Name: general
  ID:   C01234567
  Type: channel

  $ assistant use slack channels get C01234567 --json
  {"id":"C01234567","name":"general","type":"channel"}`,
    )
    .action(
      async (name: string, _opts: Record<string, unknown>, cmd: Command) => {
        const r = await cliIpcCall<ChannelEntry>("slack_use_channels_get", {
          pathParams: { name },
        });
        if (!r.ok) return exitFromIpcResult(r, cmd);

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, r.result);
        } else {
          const ch = r.result!;
          log.info(`Name: ${ch.name}`);
          log.info(`ID:   ${ch.id}`);
          log.info(`Type: ${ch.type}`);
        }
      },
    );
}
