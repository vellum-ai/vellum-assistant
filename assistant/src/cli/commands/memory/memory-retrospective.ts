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
 *   - `list` — list the most-recently-run retrospective state rows.
 */

import type { Command } from "commander";

import type { MemoryRetrospectiveOutcome } from "../../../plugins/defaults/memory/memory-retrospective-job.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export function registerMemoryRetrospectiveCommand(memory: Command): void {
  const retro = subcommand(memory, "retrospective");

  // ── run ───────────────────────────────────────────────────────────────

  subcommand(retro, "run").action(
    async (conversationId: string, opts: { json?: boolean }, cmd: Command) => {
      // Deferred: loads the config loader and retrospective job graph.
      const [{ getConfig }, { runForkBasedRetrospective }] = await Promise.all([
        import("../../../config/loader.js"),
        import("../../../plugins/defaults/memory/memory-retrospective-job.js"),
      ]);
      const config = getConfig();
      let outcome: MemoryRetrospectiveOutcome;
      try {
        outcome = await runForkBasedRetrospective(conversationId, config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, conversationId }, "memory-retrospective: run threw");
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

  // ── list ──────────────────────────────────────────────────────────────

  subcommand(retro, "list")
    .alias("ls")
    .action(async (opts: { limit?: string; json?: boolean }, cmd: Command) => {
      const limit = Math.min(
        200,
        Math.max(1, opts.limit !== undefined ? parseInt(opts.limit, 10) : 10),
      );
      if (isNaN(limit)) {
        log.error("--limit must be a number.");
        process.exitCode = 1;
        return;
      }

      const { listRetrospectiveStates } =
        await import("../../../plugins/defaults/memory/memory-retrospective-state.js");
      const rows = listRetrospectiveStates(limit);

      if (opts.json) {
        writeOutput(cmd, { rows, total: rows.length });
        return;
      }

      renderList(rows);
    });
}

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

interface RetrospectiveStateRow {
  conversationId: string;
  lastProcessedMessageId: string;
  lastRunAt: number;
  rememberedLog: string[];
}

function renderList(rows: RetrospectiveStateRow[]): void {
  if (rows.length === 0) {
    log.info("No retrospective state found. Run a retrospective first with:");
    log.info("  assistant memory retrospective run <conversationId>");
    return;
  }

  const DATE_WIDTH = 20;
  const CONV_WIDTH = 12;
  const MEM_WIDTH = 10;

  console.log(
    `${"CONVERSATION".padEnd(CONV_WIDTH)}  ${"LAST RUN".padEnd(DATE_WIDTH)}  ${"RETAINED".padEnd(MEM_WIDTH)}  STATUS`,
  );

  for (const row of rows) {
    const conv = row.conversationId.slice(0, CONV_WIDTH - 1).padEnd(CONV_WIDTH);
    const runAt = new Date(row.lastRunAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const retained = String(row.rememberedLog.length).padEnd(MEM_WIDTH);
    const status =
      row.lastProcessedMessageId === "" ? "pending (no success yet)" : "ok";
    console.log(`${conv}  ${runAt.padEnd(DATE_WIDTH)}  ${retained}  ${status}`);
  }

  console.log(`\n${rows.length} row${rows.length === 1 ? "" : "s"}`);
}

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
