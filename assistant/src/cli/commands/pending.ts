import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

interface PendingInteractionEntry {
  requestId: string;
  conversationId: string;
  kind: string;
  toolName?: string;
  riskLevel?: string;
}

interface PendingInteractionsResponse {
  interactions: PendingInteractionEntry[];
}

export function registerPendingCommand(program: Command): void {
  const pending = program
    .command("pending")
    .description(
      "Inspect pending interactions (confirmations, secrets, host proxy requests)",
    );

  pending
    .command("list")
    .alias("ls")
    .description("List all pending interactions across all conversations")
    .option(
      "--kind <kind>",
      "Filter by kind (confirmation, secret, host_bash, etc.)",
    )
    .option("--conversation <id>", "Filter by conversation ID")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        kind?: string;
        conversation?: string;
        json?: boolean;
      }) => {
        try {
          const response =
            await cliIpcCall<PendingInteractionsResponse>(
              "pending_interactions_all",
            );

          if (!response.ok || !response.result) {
            log.error(
              `Failed to list pending interactions: ${response.error ?? "unknown error"}`,
            );
            process.exitCode = 1;
            return;
          }

          let interactions = response.result.interactions;

          if (opts.kind) {
            interactions = interactions.filter(
              (i: PendingInteractionEntry) => i.kind === opts.kind,
            );
          }
          if (opts.conversation) {
            interactions = interactions.filter(
              (i: PendingInteractionEntry) =>
                i.conversationId === opts.conversation,
            );
          }

          if (opts.json) {
            console.log(JSON.stringify(interactions, null, 2));
            return;
          }

          if (interactions.length === 0) {
            console.log("No pending interactions.");
            return;
          }

          const kindWidth = Math.max(
            4,
            ...interactions.map((i: PendingInteractionEntry) => i.kind.length),
          );
          const header = `${"KIND".padEnd(kindWidth)}  ${"REQUEST ID".padEnd(36)}  ${"CONVERSATION".padEnd(36)}  DETAILS`;
          console.log(header);

          for (const i of interactions) {
            const details = i.toolName
              ? `${i.toolName} (${i.riskLevel ?? "?"})`
              : "";
            console.log(
              `${i.kind.padEnd(kindWidth)}  ${i.requestId.padEnd(36)}  ${i.conversationId.padEnd(36)}  ${details}`,
            );
          }

          console.log(`\n${interactions.length} pending interaction(s)`);
        } catch (err) {
          log.error({ err }, "Failed to list pending interactions");
          process.exitCode = 1;
        }
      },
    );
}
