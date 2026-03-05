import type { Command } from "commander";

import {
  dismissPendingConflicts,
  getMemorySystemStatus,
  queryMemory,
  requestMemoryBackfill,
  requestMemoryCleanup,
  requestMemoryRebuildIndex,
} from "../memory/admin.js";
import { listPendingConflictDetails } from "../memory/conflict-store.js";
import { listConversations } from "../memory/conversation-store.js";
import { initializeDb, rawGet } from "../memory/db.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

const SHORT_HASH_LENGTH = 8;

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Manage long-term memory indexing/retrieval");

  memory
    .command("status")
    .description("Show memory subsystem status")
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
    .action(
      (opts: {
        all?: boolean;
        pattern?: string;
        scope?: string;
        dryRun?: boolean;
      }) => {
        if (!opts.all && !opts.pattern) {
          log.info(
            "Usage: vellum memory dismiss-conflicts --all  OR  --pattern <regex>",
          );
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
