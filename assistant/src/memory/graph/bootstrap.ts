// ---------------------------------------------------------------------------
// Memory Graph — Bootstrap from historical conversations
//
// Re-extracts all historical conversations into the graph from scratch.
// Processes conversations chronologically so reinforcements, edges, and
// patterns build up naturally — the graph represents what the system
// WOULD have produced if running from the start.
//
// Checkpointed and resumable. Progress tracked via memory_checkpoints.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { and, asc, ne, sql } from "drizzle-orm";

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "../checkpoints.js";
import { getDb } from "../db.js";
import { enqueueMemoryJob, hasActiveJobOfType } from "../jobs-store.js";
import { initQdrantClient } from "../qdrant-client.js";
import { conversations, memoryGraphNodes, memorySegments } from "../schema.js";
import { runGraphExtraction } from "./extraction.js";
import { countNodes } from "./store.js";

const log = getLogger("graph-bootstrap");

const CHECKPOINT_KEY = "graph_bootstrap:last_conversation_id";

export interface BootstrapOptions {
  scopeId?: string;
  /** Skip conversations created before this epoch ms. */
  after?: number;
  /** Maximum conversations to process (for testing). */
  limit?: number;
  /** Log progress every N conversations. */
  progressInterval?: number;
  /** If true, just report what would be done without executing. */
  dryRun?: boolean;
}

export interface BootstrapResult {
  conversationsProcessed: number;
  conversationsSkipped: number;
  totalNodesCreated: number;
  totalNodesUpdated: number;
  totalNodesReinforced: number;
  totalEdgesCreated: number;
  totalTriggersCreated: number;
  errors: Array<{ conversationId: string; error: string }>;
  elapsedMs: number;
}

/**
 * Re-extract all historical conversations into the memory graph.
 *
 * Processes conversations chronologically. Resumable via checkpoint —
 * if interrupted, re-run and it picks up where it left off.
 */
export async function bootstrapFromHistory(
  options?: BootstrapOptions,
): Promise<BootstrapResult> {
  const start = Date.now();
  const scopeId = options?.scopeId ?? "default";
  const progressInterval = options?.progressInterval ?? 25;
  const config = getConfig();

  // Initialize Qdrant client for inline embedding
  try {
    initQdrantClient({
      url: config.memory.qdrant.url ?? "http://127.0.0.1:6333",
      collection: config.memory.qdrant.collection,
      vectorSize: config.memory.qdrant.vectorSize,
      onDisk: config.memory.qdrant.onDisk ?? true,
      quantization: config.memory.qdrant.quantization ?? "none",
    });
  } catch {
    // May already be initialized
  }

  const result: BootstrapResult = {
    conversationsProcessed: 0,
    conversationsSkipped: 0,
    totalNodesCreated: 0,
    totalNodesUpdated: 0,
    totalNodesReinforced: 0,
    totalEdgesCreated: 0,
    totalTriggersCreated: 0,
    errors: [],
    elapsedMs: 0,
  };

  // Load all conversations, ordered chronologically
  const db = getDb();
  const allConversations = db
    .select({
      id: conversations.id,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .orderBy(asc(conversations.createdAt))
    .all();

  log.info(
    { total: allConversations.length },
    "Starting graph bootstrap from historical conversations",
  );

  // Resume from checkpoint
  const lastProcessedId = getMemoryCheckpoint(CHECKPOINT_KEY);
  let foundCheckpoint = !lastProcessedId; // If no checkpoint, start from beginning

  for (const conv of allConversations) {
    // Skip until we pass the checkpoint
    if (!foundCheckpoint) {
      if (conv.id === lastProcessedId) {
        foundCheckpoint = true;
      }
      result.conversationsSkipped++;
      continue;
    }

    // Apply filters
    if (options?.after && conv.createdAt < options.after) {
      result.conversationsSkipped++;
      continue;
    }

    if (options?.limit && result.conversationsProcessed >= options.limit) {
      break;
    }

    if (options?.dryRun) {
      result.conversationsProcessed++;
      continue;
    }

    // Process this conversation
    try {
      const extractionResult = await runGraphExtraction(
        conv.id,
        scopeId,
        config,
        {
          skipQdrant: true, // Use DB query for candidates (no Qdrant dependency)
          conversationTimestamp: conv.createdAt, // Use actual conversation time
          embedInline: true, // Embed synchronously so nodes are searchable immediately
        },
      );

      result.totalNodesCreated += extractionResult.nodesCreated;
      result.totalNodesUpdated += extractionResult.nodesUpdated;
      result.totalNodesReinforced += extractionResult.nodesReinforced;
      result.totalEdgesCreated += extractionResult.edgesCreated;
      result.totalTriggersCreated += extractionResult.triggersCreated;
      result.conversationsProcessed++;

      // Update checkpoint after each successful extraction
      setMemoryCheckpoint(CHECKPOINT_KEY, conv.id);

      // Progress logging
      if (result.conversationsProcessed % progressInterval === 0) {
        const nodeCount = countNodes(scopeId);
        log.info(
          {
            processed: result.conversationsProcessed,
            total: allConversations.length - result.conversationsSkipped,
            nodes: nodeCount,
            elapsed: `${((Date.now() - start) / 1000).toFixed(1)}s`,
          },
          "Bootstrap progress",
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { conversationId: conv.id, err: errMsg },
        "Failed to extract conversation, continuing",
      );
      result.errors.push({ conversationId: conv.id, error: errMsg });

      // Still checkpoint — don't re-process failed conversations
      setMemoryCheckpoint(CHECKPOINT_KEY, conv.id);
    }
  }

  result.elapsedMs = Date.now() - start;

  log.info(
    {
      conversationsProcessed: result.conversationsProcessed,
      conversationsSkipped: result.conversationsSkipped,
      totalNodesCreated: result.totalNodesCreated,
      totalEdgesCreated: result.totalEdgesCreated,
      totalTriggersCreated: result.totalTriggersCreated,
      errors: result.errors.length,
      elapsedMs: result.elapsedMs,
    },
    "Graph bootstrap complete",
  );

  return result;
}

/**
 * Also extract from journal files on disk.
 */
export async function bootstrapFromJournal(
  scopeId: string = "default",
): Promise<{ extracted: number; errors: number }> {
  const config = getConfig();
  const journalDir = join(getWorkspaceDir(), "journal");
  let extracted = 0;
  let errors = 0;

  if (!existsSync(journalDir)) return { extracted, errors };

  // Iterate user slug directories
  for (const slug of readdirSync(journalDir)) {
    const slugDir = join(journalDir, slug);
    let files: string[];
    try {
      files = readdirSync(slugDir).filter(
        (f) =>
          f.endsWith(".md") &&
          !f.startsWith(".") &&
          f.toLowerCase() !== "readme.md",
      );
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const content = readFileSync(join(slugDir, file), "utf-8");
        if (content.trim().length < 50) continue;

        const transcript = `[journal entry: ${file}]\n\n${content}`;
        const journalTimestamp = parseJournalDate(file);
        await runGraphExtraction(`journal:${slug}:${file}`, scopeId, config, {
          transcript,
          conversationTimestamp: journalTimestamp,
        });
        extracted++;
      } catch (err) {
        log.warn(
          { file, slug, err: err instanceof Error ? err.message : String(err) },
          "Failed to extract journal entry",
        );
        errors++;
      }
    }
  }

  return { extracted, errors };
}

/**
 * Parse a date from a journal filename like "2026-03-30-0045.md" or "2026-03-28-early.md".
 * Returns epoch ms, defaulting to noon on the parsed date.
 * Falls back to Date.now() if unparseable.
 */
function parseJournalDate(filename: string): number {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return Date.now();

  const [, year, month, day] = match;
  // Check for a time-like suffix (e.g. "0045" → 00:45)
  const timeMatch = filename.match(/^\d{4}-\d{2}-\d{2}-(\d{4})\./);
  let hours = 12;
  let minutes = 0;
  if (timeMatch) {
    hours = parseInt(timeMatch[1].slice(0, 2), 10);
    minutes = parseInt(timeMatch[1].slice(2), 10);
  } else if (filename.includes("dawn")) {
    hours = 6;
  } else if (filename.includes("early")) {
    hours = 5;
  } else if (
    filename.includes("night") ||
    filename.includes("midnight") ||
    filename.includes("late")
  ) {
    hours = 23;
  }

  return new Date(
    `${year}-${month}-${day}T${String(hours).padStart(2, "0")}:${String(
      minutes,
    ).padStart(2, "0")}:00`,
  ).getTime();
}

/**
 * Reset the bootstrap checkpoint so it can be re-run from scratch.
 */
export function resetBootstrapCheckpoint(): void {
  setMemoryCheckpoint(CHECKPOINT_KEY, "");
}

/**
 * Enqueue a graph_bootstrap job if the graph is empty (no non-procedural nodes)
 * but historical data exists (segments or journal files). Called on daemon startup
 * to auto-populate the graph for users upgrading from the old extraction system.
 *
 * Idempotent: does nothing if graph nodes already exist or a bootstrap job is
 * already pending/running.
 */
export function maybeEnqueueGraphBootstrap(): void {
  const db = getDb();

  // Check for non-procedural graph nodes (procedural = capability seeds, not real memories)
  const nonProceduralCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(memoryGraphNodes)
      .where(
        and(
          ne(memoryGraphNodes.type, "procedural"),
          sql`${memoryGraphNodes.fidelity} != 'gone'`,
        ),
      )
      .get()?.count ?? 0;

  if (nonProceduralCount > 0) return; // Graph already populated

  // Check for historical data to bootstrap from
  const segmentCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(memorySegments)
      .get()?.count ?? 0;

  const hasJournalFiles = existsSync(join(getWorkspaceDir(), "journal"));

  if (segmentCount === 0 && !hasJournalFiles) return; // Nothing to bootstrap from

  // Don't enqueue if already in progress
  if (hasActiveJobOfType("graph_bootstrap")) return;

  log.info(
    { segmentCount, hasJournalFiles },
    "Graph empty with historical data — enqueueing bootstrap",
  );
  enqueueMemoryJob("graph_bootstrap", {});
}

// ---------------------------------------------------------------------------
// One-time cleanup: remove stale Qdrant vectors with target_type "item"
// ---------------------------------------------------------------------------

const CLEANUP_ITEM_VECTORS_CHECKPOINT = "graph_bootstrap:cleaned_item_vectors";

/**
 * Delete Qdrant vectors with target_type "item" left over from the legacy
 * memory_items system. The backing SQLite rows have been dropped (migration
 * 203), so these vectors are orphaned and waste index space.
 *
 * Checkpoint-gated: runs exactly once per workspace.
 */
export async function cleanupStaleItemVectors(): Promise<void> {
  if (getMemoryCheckpoint(CLEANUP_ITEM_VECTORS_CHECKPOINT)) return;

  let qdrant;
  try {
    qdrant = (await import("../qdrant-client.js")).getQdrantClient();
  } catch {
    // Qdrant not initialized yet — skip; will run on next startup.
    return;
  }

  try {
    await qdrant.deleteByTargetType("item");
    setMemoryCheckpoint(CLEANUP_ITEM_VECTORS_CHECKPOINT, "done");
    log.info("Cleaned up stale Qdrant vectors with target_type 'item'");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to clean up stale item vectors — will retry on next startup",
    );
  }
}
