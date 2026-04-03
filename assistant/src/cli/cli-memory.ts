import { and, eq, like, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { memoryGraphNodes } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import { buildCliProgram } from "./program.js";

const log = getLogger("cli-memory");

/**
 * Build a capability statement for a CLI command.
 * Truncated to 500 chars max (matching the limit used by memory item extraction).
 */
export function buildCliCapabilityStatement(
  name: string,
  description: string,
): string {
  let statement = `The "assistant ${name}" CLI command is available. ${description}.`;

  // Truncate to 500 chars max
  if (statement.length > 500) {
    statement = statement.slice(0, 500);
  }

  return statement;
}

/** Default emotional charge for capability graph nodes. */
const DEFAULT_EMOTIONAL_CHARGE = JSON.stringify({
  valence: 0,
  intensity: 0.1,
  decayCurve: "linear",
  decayRate: 0.05,
  originalIntensity: 0.1,
});

/**
 * Upsert a capability memory graph node for a CLI command.
 * Best-effort: errors are logged but never thrown.
 */
export function upsertCliCapabilityMemory(
  commandName: string,
  description: string,
): void {
  try {
    const db = getDb();
    const statement = buildCliCapabilityStatement(commandName, description);
    const content = `cli:${commandName}\n${statement}`;
    const scopeId = "default";
    const now = Date.now();

    const existing = db
      .select()
      .from(memoryGraphNodes)
      .where(
        and(
          eq(memoryGraphNodes.type, "procedural"),
          like(memoryGraphNodes.content, `cli:${commandName}\n%`),
          eq(memoryGraphNodes.scopeId, scopeId),
        ),
      )
      .get();

    if (existing) {
      if (
        existing.content === content &&
        existing.fidelity !== "gone"
      ) {
        // Same content — just touch lastAccessed
        db.update(memoryGraphNodes)
          .set({ lastAccessed: now })
          .where(eq(memoryGraphNodes.id, existing.id))
          .run();
        return;
      }

      if (existing.fidelity !== "gone") {
        // Content changed — update content
        db.update(memoryGraphNodes)
          .set({
            content,
            lastAccessed: now,
          })
          .where(eq(memoryGraphNodes.id, existing.id))
          .run();
        enqueueMemoryJob("embed_graph_node", { nodeId: existing.id });
        return;
      }

      // fidelity === "gone" — reactivate
      db.update(memoryGraphNodes)
        .set({
          fidelity: "vivid",
          content,
          created: now,
          lastAccessed: now,
        })
        .where(eq(memoryGraphNodes.id, existing.id))
        .run();
      enqueueMemoryJob("embed_graph_node", { nodeId: existing.id });
      return;
    }

    // No existing — insert new graph node
    const id = uuid();
    db.insert(memoryGraphNodes)
      .values({
        id,
        content,
        type: "procedural",
        created: now,
        lastAccessed: now,
        lastConsolidated: now,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 1.0,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now,
        sourceConversations: JSON.stringify([]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
        scopeId,
      })
      .run();
    enqueueMemoryJob("embed_graph_node", { nodeId: id });
  } catch (err) {
    log.warn({ err, commandName }, "Failed to upsert CLI capability memory");
  }
}

/**
 * Seed capability memory graph nodes for all CLI commands.
 * Prunes stale entries whose commands are no longer registered.
 * Best-effort: errors are logged but never thrown.
 */
export function seedCliCommandMemories(): void {
  try {
    const program = buildCliProgram();
    const commandNames = new Set<string>();

    for (const cmd of program.commands) {
      commandNames.add(cmd.name());
      upsertCliCapabilityMemory(cmd.name(), cmd.description());
    }

    // Prune stale capability memories for commands no longer registered
    const db = getDb();
    const allCapabilities = db
      .select()
      .from(memoryGraphNodes)
      .where(
        and(
          eq(memoryGraphNodes.type, "procedural"),
          eq(memoryGraphNodes.scopeId, "default"),
          sql`${memoryGraphNodes.fidelity} != 'gone'`,
        ),
      )
      .all();

    const now = Date.now();
    for (const item of allCapabilities) {
      if (!item.content.startsWith("cli:")) continue;
      const itemCommandName = item.content.split("\n")[0].replace("cli:", "");
      if (!commandNames.has(itemCommandName)) {
        db.update(memoryGraphNodes)
          .set({ fidelity: "gone", lastAccessed: now })
          .where(eq(memoryGraphNodes.id, item.id))
          .run();
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to seed CLI command memories");
  }
}
