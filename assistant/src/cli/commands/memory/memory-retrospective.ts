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
 *     Supports targeted rewind/backfill via `--from <messageId>` /
 *     `--from-start` (replay a window whose cursor already advanced) and a
 *     read-only `--dry-run` preview.
 *   - `list` — list the most-recently-run retrospective state rows.
 */

import type { Command } from "commander";

import type { MemoryRetrospectiveOutcome } from "../../../plugins/defaults/memory/memory-retrospective-job.js";
import type { MemoryRetrospectiveState } from "../../../plugins/defaults/memory/memory-retrospective-state.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

interface RetrospectiveRunFlags {
  json?: boolean;
  from?: string;
  fromStart?: boolean;
  dryRun?: boolean;
}

/**
 * Resolution of the `--from` / `--from-start` rewind flags into the
 * `overrideCursor` value `runForkBasedRetrospective` accepts:
 *
 *   - `default`: neither flag passed; the run uses the persisted cursor.
 *   - `override`: replay from `overrideCursor` (`null` means from the
 *     conversation's beginning).
 *   - `error`: invalid flag combination; `message` explains why.
 */
export type RunCursorResolution =
  | { kind: "error"; message: string }
  | { kind: "default" }
  | { kind: "override"; overrideCursor: string | null };

/**
 * Pure flag resolver for the `run` subcommand's rewind options. `--from` and
 * `--from-start` are mutually exclusive, and `--from` requires a non-empty
 * message id (the from-start sentinel is spelled `--from-start`, never an
 * empty `--from`).
 */
export function resolveRunCursorOverride(
  opts: Pick<RetrospectiveRunFlags, "from" | "fromStart">,
): RunCursorResolution {
  if (opts.from !== undefined && opts.fromStart === true) {
    return {
      kind: "error",
      message: "--from and --from-start are mutually exclusive.",
    };
  }
  if (opts.fromStart === true) {
    return { kind: "override", overrideCursor: null };
  }
  if (opts.from !== undefined) {
    if (opts.from === "") {
      return {
        kind: "error",
        message:
          "--from requires a non-empty message id (use --from-start to replay from the beginning).",
      };
    }
    return { kind: "override", overrideCursor: opts.from };
  }
  return { kind: "default" };
}

/** Human-readable rendering of a cursor value for dry-run/state output. */
export function describeCursor(cursor: string | null): string {
  if (cursor === null || cursor === "") {
    return "(start of conversation)";
  }
  return cursor;
}

export function registerMemoryRetrospectiveCommand(memory: Command): void {
  const retro = subcommand(memory, "retrospective");

  // ── run ───────────────────────────────────────────────────────────────

  subcommand(retro, "run").action(
    async (
      conversationId: string,
      opts: RetrospectiveRunFlags,
      cmd: Command,
    ) => {
      const fail = (message: string): void => {
        if (opts.json === true) {
          writeOutput(cmd, { kind: "error", error: message });
        } else {
          log.error(message);
        }
        process.exitCode = 1;
      };

      const resolution = resolveRunCursorOverride(opts);
      if (resolution.kind === "error") {
        fail(resolution.message);
        return;
      }

      // The rewind and dry-run paths validate their targets up front (both
      // are read-only lookups); the plain run defers to the job's own
      // missing-conversation handling.
      if (resolution.kind === "override" || opts.dryRun === true) {
        const { getConversation, getMessageById } =
          await import("../../../persistence/conversation-crud.js");
        if (!getConversation(conversationId)) {
          fail(`Conversation not found: ${conversationId}`);
          return;
        }
        if (
          resolution.kind === "override" &&
          resolution.overrideCursor !== null &&
          !getMessageById(resolution.overrideCursor, conversationId)
        ) {
          fail(
            `Message ${resolution.overrideCursor} not found in conversation ${conversationId}.`,
          );
          return;
        }
      }

      if (opts.dryRun === true) {
        // Purely read-only preview: no state writes, no fork, no wake.
        const [{ getRetrospectiveState }, { getRetrospectiveMessagesAfter }] =
          await Promise.all([
            import("../../../plugins/defaults/memory/memory-retrospective-state.js"),
            import("../../../plugins/defaults/memory/memory-retrospective-accounting.js"),
          ]);
        const state = getRetrospectiveState(conversationId);
        const currentCursor = state?.lastProcessedMessageId ?? null;
        const targetCursor =
          resolution.kind === "override"
            ? resolution.overrideCursor
            : currentCursor;
        const report = {
          kind: "dry_run" as const,
          conversationId,
          currentCursor,
          overrideCursor: targetCursor,
          unprocessedMessageCount: getRetrospectiveMessagesAfter(
            conversationId,
            targetCursor,
          ).length,
          lastRunAt: state?.lastRunAt ?? null,
          rememberedLogEntryCount: state?.rememberedLog.length ?? 0,
        };
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, report);
          return;
        }
        renderDryRun(report);
        return;
      }

      // Deferred: loads the config loader and retrospective job graph.
      const [{ getConfig }, { runForkBasedRetrospective }] = await Promise.all([
        import("../../../config/loader.js"),
        import("../../../plugins/defaults/memory/memory-retrospective-job.js"),
      ]);
      const config = getConfig();
      let outcome: MemoryRetrospectiveOutcome;
      try {
        outcome = await runForkBasedRetrospective(
          conversationId,
          config,
          resolution.kind === "override"
            ? { overrideCursor: resolution.overrideCursor }
            : undefined,
        );
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

      // Failure outcomes exit non-zero in every output mode, so scripted
      // callers (and the recovery runbook) can branch on the exit code
      // without parsing the payload.
      if (
        outcome.kind === "wake_failed" ||
        outcome.kind === "no_usable_output"
      ) {
        process.exitCode = 1;
      }

      if (resolution.kind === "override") {
        const { getRetrospectiveState } =
          await import("../../../plugins/defaults/memory/memory-retrospective-state.js");
        const state = getRetrospectiveState(conversationId);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { outcome, state });
          return;
        }
        renderOutcome(outcome);
        renderStateRow(state);
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

function renderList(rows: MemoryRetrospectiveState[]): void {
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
    case "no_user_activity":
      log.info(
        "The unprocessed window has no user activity; nothing to review.",
      );
      break;
    case "source_dormant":
      log.info(
        "Source conversation is dormant beyond the sweep lookback; skipping.",
      );
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
    case "no_usable_output":
      log.error(
        `Run produced no usable output` +
          `${outcome.reason ? `: ${outcome.reason}` : ""}` +
          (outcome.conversationId ? ` (fork: ${outcome.conversationId})` : "") +
          `. The window stays retryable; state was not advanced.`,
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
    default: {
      const _exhaustive: never = outcome;
      break;
    }
  }
}

function renderDryRun(report: {
  conversationId: string;
  currentCursor: string | null;
  overrideCursor: string | null;
  unprocessedMessageCount: number;
  lastRunAt: number | null;
  rememberedLogEntryCount: number;
}): void {
  log.info(
    `Dry run (no writes).\n` +
      `  conversation:        ${report.conversationId}\n` +
      `  current cursor:      ${describeCursor(report.currentCursor)}\n` +
      `  target cursor:       ${describeCursor(report.overrideCursor)}\n` +
      `  unprocessed msgs:    ${report.unprocessedMessageCount}\n` +
      `  last run at:         ${report.lastRunAt === null ? "(never)" : new Date(report.lastRunAt).toISOString()}\n` +
      `  remembered entries:  ${report.rememberedLogEntryCount}`,
  );
}

function renderStateRow(state: MemoryRetrospectiveState | null): void {
  if (!state) {
    log.info("No retrospective state row exists for this conversation.");
    return;
  }
  log.info(
    `Resulting state:\n` +
      `  cursor:              ${describeCursor(state.lastProcessedMessageId)}\n` +
      `  last run at:         ${new Date(state.lastRunAt).toISOString()}\n` +
      `  remembered entries:  ${state.rememberedLog.length}`,
  );
}
