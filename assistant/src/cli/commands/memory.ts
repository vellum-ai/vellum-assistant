import type { Command } from "commander";

import {
  dismissPendingConflicts,
  getMemorySystemStatus,
  queryMemory,
  requestMemoryBackfill,
  requestMemoryCleanup,
  requestMemoryRebuildIndex,
} from "../../memory/admin.js";
import { listPendingConflictDetails } from "../../memory/conflict-store.js";
import { listConversations } from "../../memory/conversation-queries.js";
import { initializeDb, rawGet } from "../../memory/db.js";
import { getCliLogger } from "../../util/logger.js";

const log = getCliLogger("cli");

const SHORT_HASH_LENGTH = 8;

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Manage long-term memory indexing/retrieval");

  memory.addHelpText(
    "after",
    `
The memory subsystem indexes conversation segments into full-text search (FTS)
and vector embeddings for semantic recall. When the assistant encounters new
information that contradicts a stored fact, a conflict is created and held in
"pending_clarification" status until explicitly dismissed or resolved.

Key concepts:
  segments     Chunks of conversation text extracted for indexing
  items        Distilled facts/statements derived from segments
  summaries    Compressed representations of conversation history
  embeddings   Vector representations used for semantic similarity search
  conflicts    Pairs of contradictory statements awaiting resolution

Examples:
  $ assistant memory status
  $ assistant memory query "What is the project deadline?"
  $ assistant memory backfill
  $ assistant memory dismiss-conflicts --all`,
  );

  memory
    .command("status")
    .description("Show memory subsystem status")
    .addHelpText(
      "after",
      `
Displays a comprehensive snapshot of the memory subsystem's health and counts.

Fields shown:
  enabled/degraded   Whether memory is active and whether it is running in a
                     degraded mode (e.g. missing embedding backend)
  embedding backend  The provider/model pair used for vector embeddings (or "none")
  segments           Total conversation segments indexed
  items              Total distilled fact items stored
  summaries          Total compressed conversation summaries
  embeddings         Total vector embeddings computed
  pending conflicts  Conflicts awaiting user resolution
  resolved conflicts Conflicts that have been dismissed or resolved
  oldest pending age How long the oldest unresolved conflict has been waiting
  cleanup backlogs   Number of resolved conflicts and superseded items pending cleanup
  cleanup throughput Number of cleanup operations completed in the last 24 hours
  jobs               Status of background jobs (backfill, cleanup, rebuild-index)

Examples:
  $ assistant memory status`,
    )
    .action(() => {
      initializeDb();
      const status = getMemorySystemStatus();
      log.info(`Memory enabled: ${status.enabled ? "yes" : "no"}`);
      log.info(`Memory degraded: ${status.degraded ? "yes" : "no"}`);
      if (status.reason) log.info(`Reason: ${status.reason}`);
      if (status.provider && status.model) {
        log.info(`Embedding backend: ${status.provider}/${status.model}`);
      } else {
        log.info("Embedding backend: none");
      }
      log.info(`Segments: ${status.counts.segments.toLocaleString()}`);
      log.info(`Items: ${status.counts.items.toLocaleString()}`);
      log.info(`Summaries: ${status.counts.summaries.toLocaleString()}`);
      log.info(`Embeddings: ${status.counts.embeddings.toLocaleString()}`);
      log.info(
        `Pending conflicts: ${status.conflicts.pending.toLocaleString()}`,
      );
      log.info(
        `Resolved conflicts: ${status.conflicts.resolved.toLocaleString()}`,
      );
      if (status.conflicts.oldestPendingAgeMs != null) {
        const oldestMinutes = Math.floor(
          status.conflicts.oldestPendingAgeMs / 60_000,
        );
        log.info(`Oldest pending conflict age: ${oldestMinutes} min`);
      } else {
        log.info("Oldest pending conflict age: n/a");
      }
      log.info(
        `Cleanup backlog (resolved conflicts): ${status.cleanup.resolvedBacklog.toLocaleString()}`,
      );
      log.info(
        `Cleanup backlog (superseded items): ${status.cleanup.supersededBacklog.toLocaleString()}`,
      );
      log.info(
        `Cleanup throughput 24h (resolved conflicts): ${status.cleanup.resolvedCompleted24h.toLocaleString()}`,
      );
      log.info(
        `Cleanup throughput 24h (superseded items): ${status.cleanup.supersededCompleted24h.toLocaleString()}`,
      );
      log.info("Jobs:");
      for (const [key, value] of Object.entries(status.jobs)) {
        log.info(`  ${key}: ${value}`);
      }
    });

  memory
    .command("backfill")
    .description("Queue a memory backfill job")
    .option("-f, --force", "Restart backfill from the beginning")
    .addHelpText(
      "after",
      `
Queues a background job to index unprocessed conversation segments into FTS
and vector embeddings. The job resumes from where the last backfill left off,
processing only new or unindexed segments.

The --force flag restarts the backfill from the very beginning, reprocessing
all segments regardless of whether they have already been indexed. This is
useful after bulk imports or if the incremental state has become inconsistent.

Examples:
  $ assistant memory backfill
  $ assistant memory backfill --force`,
    )
    .action((opts: { force?: boolean }) => {
      initializeDb();
      const jobId = requestMemoryBackfill(Boolean(opts?.force));
      log.info(`Queued backfill job: ${jobId}`);
    });

  memory
    .command("cleanup")
    .description(
      "Queue cleanup jobs for resolved conflicts and stale superseded items",
    )
    .option(
      "--retention-ms <ms>",
      "Optional retention threshold in milliseconds",
    )
    .addHelpText(
      "after",
      `
Queues two background cleanup jobs:
  1. Resolved conflicts cleanup — removes conflict records that have been
     dismissed or resolved past the retention threshold.
  2. Stale superseded items cleanup — removes memory items that have been
     superseded by newer, corrected facts past the retention threshold.

The optional --retention-ms flag sets the minimum age (in milliseconds) a
record must have before it is eligible for cleanup. If omitted, the system
default retention period is used.

Examples:
  $ assistant memory cleanup
  $ assistant memory cleanup --retention-ms 86400000`,
    )
    .action((opts: { retentionMs?: string }) => {
      initializeDb();
      const retentionMs = opts.retentionMs
        ? Number.parseInt(opts.retentionMs, 10)
        : undefined;
      const jobs = requestMemoryCleanup(
        Number.isFinite(retentionMs) ? retentionMs : undefined,
      );
      log.info(
        `Queued cleanup_resolved_conflicts job: ${jobs.resolvedConflictsJobId}`,
      );
      log.info(
        `Queued cleanup_stale_superseded_items job: ${jobs.staleSupersededItemsJobId}`,
      );
    });

  memory
    .command("query <text>")
    .description(
      "Run a memory recall query and print the injected memory payload",
    )
    .option("-s, --session <id>", "Optional conversation/session ID")
    .addHelpText(
      "after",
      `
Arguments:
  text   The recall query string used to search memory (e.g. "What is the
         project deadline?"). Matched against indexed segments using the full
         recall pipeline: lexical (FTS), semantic (vector similarity), recency
         (time-weighted), and entity (named entity extraction).

Runs the complete memory recall pipeline and displays hit counts for each
retrieval strategy, the total injected token count, query latency, and the
assembled memory text that would be injected into context.

The optional --session flag provides a conversation/session ID for
context-aware recall. If omitted, the most recent conversation is used.

Examples:
  $ assistant memory query "What is the project deadline?"
  $ assistant memory query "preferred communication style" --session conv_abc123
  $ assistant memory query "API rate limits"`,
    )
    .action(async (text: string, opts?: { session?: string }) => {
      initializeDb();
      let sessionId = opts?.session;
      if (!sessionId) {
        const latest = listConversations(1)[0];
        sessionId = latest?.id ?? "";
      }
      const result = await queryMemory(text, sessionId ?? "");
      if (result.degraded) {
        log.info(`Memory degraded: ${result.reason ?? "unknown reason"}`);
      }
      log.info(`Lexical hits: ${result.lexicalHits}`);
      log.info(`Semantic hits: ${result.semanticHits}`);
      log.info(`Recency hits: ${result.recencyHits}`);
      log.info(`Entity hits: ${result.entityHits}`);
      log.info(`Injected tokens: ${result.injectedTokens}`);
      log.info(`Latency: ${result.latencyMs}ms`);
      if (result.injectedText.length > 0) {
        log.info("");
        log.info(result.injectedText);
      } else {
        log.info("No memory injected.");
      }
    });

  memory
    .command("rebuild-index")
    .description("Queue a memory FTS+embedding index rebuild job")
    .addHelpText(
      "after",
      `
Queues a background job that performs a full rebuild of both the FTS (full-text
search) index and the vector embedding index. All existing index data is
dropped and reconstructed from the source memory items.

This is useful after schema changes, embedding model upgrades, or if index
corruption is suspected. The rebuild runs asynchronously; use "assistant memory
status" to monitor job progress.

Examples:
  $ assistant memory rebuild-index
  $ assistant memory status`,
    )
    .action(() => {
      initializeDb();
      const jobId = requestMemoryRebuildIndex();
      log.info(`Queued rebuild-index job: ${jobId}`);
    });

  memory
    .command("dismiss-conflicts")
    .description("Dismiss pending memory conflicts (all or matching a pattern)")
    .option("-a, --all", "Dismiss all pending conflicts")
    .option(
      "-p, --pattern <regex>",
      "Dismiss conflicts where either statement matches this regex",
    )
    .option("-s, --scope <id>", 'Memory scope (default: "default")')
    .option("--dry-run", "Show what would be dismissed without making changes")
    .addHelpText(
      "after",
      `
Two modes of operation:
  --all              Dismiss every pending conflict in the scope
  --pattern <regex>  Dismiss only conflicts where either the existing or
                     candidate statement matches the given regex (case-insensitive)

At least one of --all or --pattern must be provided. If both are given,
--all takes priority and all pending conflicts are dismissed.

The --scope flag targets a specific memory scope. Defaults to "default" if
omitted. The --dry-run flag previews which conflicts would be dismissed
without actually modifying any records.

Examples:
  $ assistant memory dismiss-conflicts --all
  $ assistant memory dismiss-conflicts --pattern "project deadline" --dry-run
  $ assistant memory dismiss-conflicts --pattern "^preferred\\b" --scope work`,
    )
    .action(
      (opts: {
        all?: boolean;
        pattern?: string;
        scope?: string;
        dryRun?: boolean;
      }) => {
        if (!opts.all && !opts.pattern) {
          log.info("At least one of --all or --pattern must be provided.");
          log.info("Use --dry-run to preview without making changes.");
          return;
        }

        initializeDb();

        const pattern = opts.pattern
          ? new RegExp(opts.pattern, "i")
          : undefined;

        if (opts.dryRun) {
          const scopeId = opts.scope ?? "default";
          const totalPending =
            rawGet<{ c: number }>(
              `SELECT COUNT(*) AS c FROM memory_item_conflicts WHERE scope_id = ? AND status = 'pending_clarification'`,
              scopeId,
            )?.c ?? 0;

          // Show a sample of conflicts (can't paginate without dismissing)
          const sample = listPendingConflictDetails(scopeId, 1000);
          let matchCount = 0;
          for (const conflict of sample) {
            const matches =
              opts.all ||
              (pattern &&
                (pattern.test(conflict.existingStatement) ||
                  pattern.test(conflict.candidateStatement)));
            if (!matches) continue;
            matchCount++;
            log.info(
              `  [${conflict.id.slice(0, SHORT_HASH_LENGTH)}] "${
                conflict.existingStatement
              }" vs "${conflict.candidateStatement}"`,
            );
          }

          if (opts.all) {
            // --all matches everything, so matchCount is just the sample size
            log.info(
              `\nDry run: ${totalPending} of ${totalPending} pending conflicts would be dismissed.`,
            );
          } else {
            const moreNote =
              totalPending > sample.length
                ? ` (showing first ${sample.length} of ${totalPending})`
                : "";
            log.info(
              `\nDry run: ${matchCount} of ${totalPending} pending conflicts would be dismissed.${moreNote}`,
            );
          }
          return;
        }

        const result = dismissPendingConflicts({
          all: opts.all,
          pattern,
          scopeId: opts.scope,
        });
        for (const detail of result.details) {
          log.info(
            `  Dismissed [${detail.id.slice(0, SHORT_HASH_LENGTH)}]: "${
              detail.existingStatement
            }" vs "${detail.candidateStatement}"`,
          );
        }
        log.info(
          `\nDismissed ${result.dismissed} conflicts. ${result.remaining} pending conflicts remain.`,
        );
      },
    );
}
