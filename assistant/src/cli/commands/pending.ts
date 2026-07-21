import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { pendingHelp } from "./pending.help.js";

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
  registerCommand(program, {
    name: pendingHelp.name,
    transport: "ipc",
    description: pendingHelp.description,
    build: (pending) => {
      applyCommandHelp(pending, pendingHelp);

      // The "ls" alias is not expressible in CliCommandHelp, so it is
      // attached imperatively after the declarative registration.
      subcommand(pending, "list")
        .alias("ls")
        .action(
          async (opts: {
            kind?: string;
            conversation?: string;
            json?: boolean;
          }) => {
            try {
              const response = await cliIpcCall<PendingInteractionsResponse>(
                "pending_interactions",
              );

              if (!response.ok) {
                return exitFromIpcResult({
                  ok: false,
                  error: response.error,
                  statusCode: response.statusCode,
                });
              }
              if (!response.result) {
                log.error(
                  "pending_interactions returned ok with no result body",
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
                ...interactions.map(
                  (i: PendingInteractionEntry) => i.kind.length,
                ),
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
    },
  });
}
