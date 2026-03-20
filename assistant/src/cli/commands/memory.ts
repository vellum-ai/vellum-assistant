import type { Command } from "commander";

import {
  getMemorySystemStatus,
  requestMemoryBackfill,
  requestMemoryRebuildIndex,
} from "../../memory/admin.js";
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
