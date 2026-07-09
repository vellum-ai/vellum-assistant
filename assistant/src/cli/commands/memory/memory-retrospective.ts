/**
 * `assistant memory retrospective` CLI subgroup.
 *
 * Runs memory retrospectives directly in the CLI process — no IPC, no daemon
 * required. Each subcommand imports the retrospective machinery and calls it
 * against the workspace's on-disk SQLite database directly.
 *
 * Subcommands:
 *
 *   - `run <conversationId>` — run a fork-based retrospective on a conversation.
 *   - `list` — list the last five retrospectives (TODO).
 */

import type { Command } from "commander";

import type { MemoryRetrospectiveOutcome } from "../../../plugins/defaults/memory/memory-retrospective-job.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export function registerMemoryRetrospectiveCommand(memory: Command): void {
  registerCommand(memory, {
    name: "retrospective",
    transport: "local",
    description: "Run and inspect memory retrospectives (direct, no IPC)",
    build: (retro) => {
      retro.addHelpText(
        "after",
        `
Runs memory retrospectives directly against the workspace database — the CLI
process imports the retrospective machinery and calls it in-process, so no
running daemon is required.

Examples:
  $ assistant memory retrospective run <conversationId>`,
      );

      // ── run ───────────────────────────────────────────────────────────────

      retro
        .command("run")
        .description("Run a fork-based retrospective on a conversation")
        .argument("<conversationId>", "Source conversation to retrospective")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .addHelpText(
          "after",
          `
Forks the source conversation through its latest message, persists a
retrospective instruction, and wakes the fork so the agent reviews the new
messages and calls \`remember\` on anything worth saving. Runs entirely in the
CLI process — no IPC round-trip to the daemon.

Examples:
  $ assistant memory retrospective run abc123`,
        )
        .action(
          async (
            conversationId: string,
            opts: { json?: boolean },
            cmd: Command,
          ) => {
            // Deferred: loads the config loader and retrospective job graph.
            const [{ getConfig }, { runForkBasedRetrospective }] =
              await Promise.all([
                import("../../../config/loader.js"),
                import("../../../plugins/defaults/memory/memory-retrospective-job.js"),
              ]);
            const config = getConfig();
            let outcome: MemoryRetrospectiveOutcome;
            try {
              outcome = await runForkBasedRetrospective(conversationId, config);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.error(
                { err, conversationId },
                "memory-retrospective: run threw",
              );
              if (opts.json === true) {
                writeOutput(cmd, { kind: "error", error: msg });
              } else {
                log.error(msg);
              }
              process.exitCode = 1;
              return;
            }

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, outcome);
              return;
            }

            renderOutcome(outcome);
          },
        );
    },
  });
}

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

function renderOutcome(outcome: MemoryRetrospectiveOutcome): void {
  switch (outcome.kind) {
    case "disabled":
      log.info("Retrospective is disabled for this workspace.");
      break;
    case "no_new_messages":
      log.info("No new messages to review since the last retrospective.");
      break;
    case "source_processing":
      log.info(
        "Source conversation is mid-turn; skipping (will retry next trigger).",
      );
      break;
    case "wake_failed":
      log.error(
        `Wake failed${outcome.reason ? `: ${outcome.reason}` : ""}` +
          (outcome.conversationId ? ` (fork: ${outcome.conversationId})` : ""),
      );
      process.exitCode = 1;
      break;
    case "invoked":
      log.info(
        `Retrospective invoked.\n` +
          `  fork conversation: ${outcome.backgroundConversationId}\n` +
          `  cutoff message:    ${outcome.cutoffMessageId}\n` +
          `  new messages:      ${outcome.newMessageCount}` +
          (outcome.followUpJobIds.length > 0
            ? `\n  follow-up jobs:    ${outcome.followUpJobIds.join(", ")}`
            : ""),
      );
      break;
  }
}
