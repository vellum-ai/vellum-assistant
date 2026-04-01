import { and, eq, like, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { resolveSkillStates } from "../config/skill-state.js";
import { loadSkillCatalog, type SkillSummary } from "../config/skills.js";
import { getDb } from "../memory/db.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { memoryGraphNodes } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("skill-memory");

/** Escape SQL LIKE wildcards (`%` and `_`) so they match literally. */
function escapeLike(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Generic input for building capability statements.
 * Decoupled from CatalogSkill so other skill sources (e.g. bundled skills) can
 * produce capability memories without being shoehorned into the catalog type.
 */
export interface SkillCapabilityInput {
  id: string;
  displayName: string;
  description: string;
  activationHints?: string[];
  avoidWhen?: string[];
}

/**
 * Convert a SkillSummary to a SkillCapabilityInput.
 * SkillSummary already has flat properties, so this is a straightforward mapping.
 */
export function fromSkillSummary(entry: SkillSummary): SkillCapabilityInput {
  return {
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    activationHints: entry.activationHints,
    avoidWhen: entry.avoidWhen,
  };
}

/**
 * Build a semantically rich capability statement from a skill capability input.
 * Truncated to 500 chars max (matching the limit used by memory item extraction).
 */
export function buildCapabilityStatement(input: SkillCapabilityInput): string {
  const { displayName, activationHints, avoidWhen } = input;

  let statement = `The "${displayName}" skill (${input.id}) is available. ${input.description}.`;
  if (activationHints && activationHints.length > 0) {
    statement += ` Use when: ${activationHints.join("; ")}.`;
  }
  if (avoidWhen && avoidWhen.length > 0) {
    statement += ` Avoid when: ${avoidWhen.join("; ")}.`;
  }

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
 * Upsert a capability memory graph node for a skill.
 * Best-effort: errors are logged but never thrown.
 */
export function upsertSkillCapabilityMemory(
  skillId: string,
  input: SkillCapabilityInput,
): void {
  try {
    const db = getDb();
    const statement = buildCapabilityStatement(input);
    const content = `skill:${skillId}\n${statement}`;
    const scopeId = "default";
    const now = Date.now();

    const existing = db
      .select()
      .from(memoryGraphNodes)
      .where(
        and(
          eq(memoryGraphNodes.type, "procedural"),
          like(memoryGraphNodes.content, `skill:${escapeLike(skillId)}\n%`),
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
    log.warn({ err, skillId }, "Failed to upsert skill capability memory");
  }
}

/**
 * Soft-delete the capability memory graph node for a skill.
 * Best-effort: errors are logged but never thrown.
 */
export function deleteSkillCapabilityMemory(skillId: string): void {
  try {
    const db = getDb();
    const now = Date.now();

    const existing = db
      .select()
      .from(memoryGraphNodes)
      .where(
        and(
          eq(memoryGraphNodes.type, "procedural"),
          like(memoryGraphNodes.content, `skill:${escapeLike(skillId)}\n%`),
          eq(memoryGraphNodes.scopeId, "default"),
          sql`${memoryGraphNodes.fidelity} != 'gone'`,
        ),
      )
      .get();

    if (existing) {
      db.update(memoryGraphNodes)
        .set({ fidelity: "gone", lastAccessed: now })
        .where(eq(memoryGraphNodes.id, existing.id))
        .run();
    }
  } catch (err) {
    log.warn({ err, skillId }, "Failed to delete skill capability memory");
  }
}

/**
 * Seed capability memory graph nodes for all enabled skills (bundled, managed, workspace, extra).
 * Prunes stale entries whose skills are no longer in the enabled set.
 * Best-effort: errors are logged but never thrown.
 */
export function seedCatalogSkillMemories(): void {
  try {
    const catalog = loadSkillCatalog();
    const config = getConfig();
    const resolved = resolveSkillStates(catalog, config);
    const enabled = resolved.filter((r) => r.state === "enabled");

    const catalogIds = new Set<string>();
    for (const { summary } of enabled) {
      catalogIds.add(summary.id);
      const input = fromSkillSummary(summary);

      // Enrich mcp-setup description with configured server names
      if (summary.id === "mcp-setup") {
        const servers = config.mcp?.servers;
        if (servers) {
          const names = Object.keys(servers).filter(
            (name) => servers[name]?.enabled !== false,
          );
          if (names.length > 0) {
            input.description += ` Configured: ${names.join(", ")}`;
          }
        }
      }

      upsertSkillCapabilityMemory(summary.id, input);
    }

    // Prune stale capability memories for skills no longer in the enabled set
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
      if (!item.content.startsWith("skill:")) continue;
      const itemSkillId = item.content.split("\n")[0].replace("skill:", "");
      if (!catalogIds.has(itemSkillId)) {
        db.update(memoryGraphNodes)
          .set({ fidelity: "gone", lastAccessed: now })
          .where(eq(memoryGraphNodes.id, item.id))
          .run();
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to seed catalog skill memories");
  }
}
