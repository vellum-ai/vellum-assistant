import type { Command } from "commander";

import {
  cleanupShortSegments,
  compactLongMemoryNodes,
  findReextractTarget,
  findReextractTargets,
  getMemorySystemStatus,
  queryMemory,
  requestMemoryBackfill,
  requestMemoryRebuildIndex,
  requestReextract,
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
  graph nodes        Total memory graph nodes stored
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
      log.info(`Graph nodes: ${status.counts.graphNodes.toLocaleString()}`);
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
    .command("cleanup-segments")
    .description("Remove short segments that waste retrieval budget")
    .option("--dry-run", "Show count of segments that would be removed")
    .addHelpText(
      "after",
      `
Removes segments shorter than the minimum character threshold from both
SQLite and Qdrant. Short fragments (e.g. "OK sounds good") burn embedding
budget, retrieval slots, and injection tokens without adding value.

New segments are already filtered at creation time. This command cleans up
existing short segments that were stored before the filter was added.

Examples:
  $ assistant memory cleanup-segments
  $ assistant memory cleanup-segments --dry-run`,
    )
    .action(async (opts: { dryRun?: boolean }) => {
      initializeDb();
      const result = await cleanupShortSegments({ dryRun: opts.dryRun });
      if (opts.dryRun) {
        log.info(
          `Dry run: ${result.dryRunCount} short segment(s) would be removed.`,
        );
      } else {
        log.info(`Removed ${result.removed} short segment(s).`);
        if (result.failed > 0) {
          log.warn(
            `${result.failed} segment(s) skipped — Qdrant deletion failed. Re-run when Qdrant is available.`,
          );
        }
      }
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
         recall pipeline: semantic (dense + sparse vector similarity).

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
      log.info(`Results: ${result.results.length}`);
      log.info(`Mode: ${result.mode}`);
      if (result.results.length > 0) {
        log.info("");
        for (const r of result.results) {
          log.info(
            `[${r.type}] (confidence: ${r.confidence.toFixed(
              2,
            )}, score: ${r.score.toFixed(3)})`,
          );
          log.info(r.content);
          log.info("");
        }
      } else {
        log.info("No results found.");
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

  memory
    .command("re-extract")
    .description(
      "Re-extract memories from conversations using the latest extraction prompt",
    )
    .option(
      "-c, --conversation <id>",
      "Target a specific conversation by ID (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option("-t, --top <n>", "Auto-select top N conversations by message count")
    .option("--dry-run", "Show what would be re-extracted without doing it")
    .addHelpText(
      "after",
      `
Re-runs memory extraction on existing conversations using the current
extraction prompt. This is useful after updating the extraction prompt
(e.g. importance scoring rework) to re-score and re-extract memories
from historically important conversations.

The command resets extraction checkpoints so the graph extraction handler
re-processes all messages. Existing memories are provided as supersession
context — the new extraction can supersede old flat-fact memories with
richer, properly-scored replacements.

Requires the assistant to be running (jobs are processed by the
background worker).

Examples:
  $ assistant memory re-extract --top 20
  $ assistant memory re-extract --conversation conv_abc123
  $ assistant memory re-extract --top 10 --dry-run`,
    )
    .action(
      (opts: { conversation?: string[]; top?: string; dryRun?: boolean }) => {
        initializeDb();

        const targets = [];

        // Collect targets from --conversation flags
        if (opts.conversation && opts.conversation.length > 0) {
          for (const id of opts.conversation) {
            const target = findReextractTarget(id);
            if (target) {
              targets.push(target);
            } else {
              log.info(`Conversation not found: ${id}`);
            }
          }
        }

        // Collect targets from --top flag
        if (opts.top) {
          const n = Number.parseInt(opts.top, 10);
          if (!Number.isFinite(n) || n <= 0) {
            log.info("--top must be a positive integer");
            return;
          }
          const topTargets = findReextractTargets(n);
          // Deduplicate against conversation targets
          const seen = new Set(targets.map((t) => t.conversationId));
          for (const t of topTargets) {
            if (!seen.has(t.conversationId)) {
              targets.push(t);
              seen.add(t.conversationId);
            }
          }
        }

        if (targets.length === 0) {
          log.info(
            "No targets specified. Use --conversation <id> or --top <n>.",
          );
          return;
        }

        // Show targets
        log.info(`\nRe-extraction targets (${targets.length}):`);
        for (const t of targets) {
          const title = t.title ?? "(untitled)";
          log.info(`  ${t.conversationId}  ${t.messageCount} msgs  "${title}"`);
        }

        if (opts.dryRun) {
          log.info("\n--dry-run: no jobs queued.");
          return;
        }

        const { jobIds } = requestReextract(targets);
        log.info(
          `\nQueued ${jobIds.length} re-extraction job(s). The assistant will process them in the background.`,
        );
      },
    );

  memory
    .command("compact")
    .description(
      "Rewrite memory nodes whose content exceeds the length cap (backfill)",
    )
    .option(
      "--threshold <n>",
      "Content length threshold — nodes longer than this are candidates (default: 400)",
      (v: string) => Number.parseInt(v, 10),
      400,
    )
    .option(
      "--limit <n>",
      "Maximum number of candidates to process (default: no limit)",
      (v: string) => Number.parseInt(v, 10),
    )
    .option("--apply", "Rewrite content (default is a candidate-only preview)")
    .addHelpText(
      "after",
      `
One-off backfill for memory graphs that accumulated over-long content before
the extraction prompt was tightened to enforce the 1-3 sentence / ~300
character cap. Scans memory_graph_nodes (skipping fidelity=gone) for entries
whose content length exceeds --threshold, then either lists them (default)
or rewrites each via the memoryConsolidation LLM call site (--apply).

Only the content field is rewritten; significance, emotionalCharge, edges,
triggers, and image_refs are preserved. Each rewrite is logged in
memory_graph_node_edits with source="manual" so it is reversible.

Start with a bounded spot-check before processing the whole graph:

  $ assistant memory compact --limit 3 --apply

Examples:
  $ assistant memory compact                     # preview candidates
  $ assistant memory compact --threshold 500     # tighter threshold
  $ assistant memory compact --limit 5 --apply   # rewrite first 5
  $ assistant memory compact --apply             # rewrite everything`,
    )
    .action(
      async (opts: { threshold: number; limit?: number; apply?: boolean }) => {
        initializeDb();
        const apply = Boolean(opts.apply);

        if (!Number.isFinite(opts.threshold) || opts.threshold <= 0) {
          log.info("--threshold must be a positive integer");
          return;
        }
        if (
          opts.limit !== undefined &&
          (!Number.isFinite(opts.limit) || opts.limit <= 0)
        ) {
          log.info("--limit must be a positive integer");
          return;
        }

        log.info(
          `Scanning memory_graph_nodes for content > ${opts.threshold} chars${
            apply ? "" : " (preview — no changes will be written)"
          }...`,
        );

        const result = await compactLongMemoryNodes({
          threshold: opts.threshold,
          limit: opts.limit,
          apply,
          onCandidates: (candidates) => {
            log.info(`Found ${candidates.length} candidate node(s)`);
            if (!apply) {
              for (const c of candidates) {
                log.info(`  ${c.id}  ${c.beforeLen} chars`);
              }
            }
          },
          onProgress: (evt) => {
            const tag = `[${evt.action}]`;
            log.info(
              `${tag} ${evt.nodeId}: ${evt.beforeLen} → ${evt.afterLen} chars${
                evt.reason ? ` (${evt.reason})` : ""
              }`,
            );
            if (evt.newContent && evt.action === "compacted") {
              log.info(`  new: ${evt.newContent}`);
            }
          },
        });

        log.info("");
        log.info(`Scanned above threshold: ${result.scanned}`);
        log.info(`Processed:               ${result.processed}`);
        if (apply) {
          log.info(`Compacted:               ${result.compacted}`);
          log.info(`Skipped:                 ${result.skipped}`);
          log.info(`Failures:                ${result.failures}`);
          if (result.processed > 0) {
            log.info(
              `Chars: ${result.beforeChars} → ${result.afterChars} (saved ${
                result.beforeChars - result.afterChars
              })`,
            );
          }
        } else if (result.processed > 0) {
          log.info("");
          log.info("Preview only. Re-run with --apply to rewrite.");
        }
      },
    );
}
