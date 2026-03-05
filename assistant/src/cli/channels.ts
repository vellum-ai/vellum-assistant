import type { Command } from "commander";

import { gatewayGet, runRead, toQueryString } from "./integrations.js";

export function registerChannelsCommand(program: Command): void {
  const channels = program
    .command("channels")
    .description("Query channel status")
    .option("--json", "Machine-readable compact JSON output");

  channels
    .command("readiness")
    .description("Check channel readiness for accepting messages")
    .option("--channel <channel>", "Filter by channel type")
    .action(async (opts: { channel?: string }, cmd: Command) => {
      const query = toQueryString({ channel: opts.channel });
      await runRead(cmd, async () =>
        gatewayGet(`/v1/channels/readiness${query}`),
      );
    });
}
