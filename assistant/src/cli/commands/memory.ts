import type { Command } from "commander";

import {
  getMemorySystemStatus,
  queryMemory,
  requestMemoryBackfill,
  requestMemoryCleanup,
  requestMemoryRebuildIndex,
} from "../../memory/admin.js";
import { listConversations } from "../../memory/conversation-queries.js";
import { initializeDb } from "../db.js";
import { log } from "../logger.js";

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Manage long-term memory indexing/retrieval");

  memory.addHelpText(
    "after",
    `
The memory subsystem indexes conversation segments using hybrid search (dense
and sparse vector embeddings) for semantic recall, with tier classification
to prioritize high-value memories.

Key concepts:
  segments     Chunks of conversation text extracted for indexing
  items        Distilled facts/statements derived from segments
  summaries    Compressed representations of conversation history
  embeddings   Vector representations used for semantic similarity search

Examples:
  $ assistant memory status
  $ assistant memory query "What is the project deadline?"
  $ assistant memory backfill`,
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
  cleanup backlogs   Number of superseded items pending cleanup
  cleanup throughput Number of cleanup operations completed in the last 24 hours
  jobs               Status of background jobs (backfill, cleanup, rebuild-index)

Examples:
  $ assistant memory status`,
    )
    .action(async () => {
      initializeDb();
      const status = await getMemorySystemStatus();
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
        `Cleanup backlog (superseded items): ${status.cleanup.supersededBacklog.toLocaleString()}`,
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
Queues a background job to index unprocessed conversation segments into
vector embeddings. The job resumes from where the last backfill left off,
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
    .description("Queue cleanup jobs for stale superseded items")
    .option(
      "--retention-ms <ms>",
      "Optional retention threshold in milliseconds",
    )
    .addHelpText(
      "after",
      `
Queues a background cleanup job to remove memory items that have been
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
        `Queued cleanup_stale_superseded_items job: ${jobs.staleSupersededItemsJobId}`,
      );
    });

  memory
    .command("query <text>")
    .description(
      "Run a memory recall query and print the injected memory payload",
    )
    .option("-c, --conversation <id>", "Optional conversation ID")
    .addHelpText(
      "after",
      `
Arguments:
  text   The recall query string used to search memory (e.g. "What is the
         project deadline?"). Matched against indexed segments using the full
         recall pipeline: semantic (dense + sparse vector similarity) and recency
         (time-weighted).

Runs the complete memory recall pipeline and displays hit counts for each
retrieval strategy, the total injected token count, query latency, and the
assembled memory text that would be injected into context.

The optional --conversation flag provides a conversation ID for
context-aware recall. If omitted, the most recent conversation is used.

Examples:
  $ assistant memory query "What is the project deadline?"
  $ assistant memory query "preferred communication style" --conversation conv_abc123
  $ assistant memory query "API rate limits"`,
    )
    .action(async (text: string, opts?: { conversation?: string }) => {
      initializeDb();
      let conversationId = opts?.conversation;
      if (!conversationId) {
        const latest = listConversations(1)[0];
        conversationId = latest?.id ?? "";
      }
      const result = await queryMemory(text, conversationId ?? "");
      if (result.degraded) {
        log.info(`Memory degraded: ${result.reason ?? "unknown reason"}`);
      }
      log.info(`Semantic hits: ${result.semanticHits}`);
      log.info("Recency hits: 0");
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
    .description("Queue a memory embedding index rebuild job")
    .addHelpText(
      "after",
      `
Queues a background job that performs a full rebuild of the vector embedding
index. All existing index data is dropped and reconstructed from the source
memory items.

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
}
