import type { Command } from "commander";

import { gatewayGet, runRead, toQueryString } from "./integrations.js";

export function registerChannelsCommand(program: Command): void {
  const channels = program
    .command("channels")
    .description("Query channel status")
    .option("--json", "Machine-readable compact JSON output");

  channels.addHelpText(
    "after",
    `
Queries channel readiness and configuration status through the gateway API.
Channels are the communication interfaces (telegram, voice, sms, email, etc.)
that the assistant uses to send and receive messages.

The assistant must be running — channel status is read from the live gateway.

Examples:
  $ vellum channels readiness
  $ vellum channels readiness --channel telegram
  $ vellum channels readiness --json`,
  );

  channels
    .command("readiness")
    .description("Check channel readiness for accepting messages")
    .option("--channel <channel>", "Filter by channel type")
    .addHelpText(
      "after",
      `
Reports whether each configured channel is ready to accept messages. A channel
is "ready" when its credentials are valid, its integration is connected, and
it can deliver messages to the user.

The --channel flag filters results to a single channel type. Without it, all
configured channels are returned. Common channel types include: telegram,
voice, sms, email, slack, vellum.

Examples:
  $ vellum channels readiness
  $ vellum channels readiness --channel telegram`,
    )
    .action(async (opts: { channel?: string }, cmd: Command) => {
      const query = toQueryString({ channel: opts.channel });
      await runRead(cmd, async () =>
        gatewayGet(`/v1/channels/readiness${query}`),
      );
    });
}
