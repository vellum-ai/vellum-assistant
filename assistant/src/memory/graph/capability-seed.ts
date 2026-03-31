// ---------------------------------------------------------------------------
// Memory Graph — Capability seeding for skills and CLI commands
//
// Creates graph nodes for skill/CLI capabilities so they participate in
// semantic retrieval. Mirrors the old memoryItems-based seeding in
// skill-memory.ts and cli-memory.ts.
// ---------------------------------------------------------------------------

import { and, eq, like } from "drizzle-orm";

import { buildCliProgram } from "../../cli/program.js";
import { getConfig } from "../../config/loader.js";
import { resolveSkillStates } from "../../config/skill-state.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { getDb } from "../db.js";
import { enqueueMemoryJob } from "../jobs-store.js";
import { memoryGraphNodes } from "../schema.js";
import {
  fromSkillSummary,
  type SkillCapabilityInput,
} from "../../skills/skill-memory.js";
import { getLogger } from "../../util/logger.js";
import { createNode } from "./store.js";

const log = getLogger("graph-capability-seed");

/** Stable prefix for capability node source tracking. */
const SKILL_SOURCE_PREFIX = "capability:skill:";
const CLI_SOURCE_PREFIX = "capability:cli:";

/**
 * Upsert a graph node for a skill capability.
 * Uses sourceConversations[0] as a stable key for deduplication.
 */
export function upsertSkillCapabilityNode(
  skillId: string,
  input: SkillCapabilityInput,
): void {
  try {
    const content = buildSkillContent(input);
    const sourceKey = `${SKILL_SOURCE_PREFIX}${skillId}`;
    upsertCapabilityNode(sourceKey, content);
  } catch (err) {
    log.warn({ err, skillId }, "Failed to upsert skill capability graph node");
  }
}

/**
 * Upsert a graph node for a CLI command capability.
 */
export function upsertCliCapabilityNode(
  commandName: string,
  description: string,
): void {
  try {
    const content = `The "assistant ${commandName}" CLI command is available. ${description}.`;
    const sourceKey = `${CLI_SOURCE_PREFIX}${commandName}`;
    upsertCapabilityNode(sourceKey, content);
  } catch (err) {
    log.warn(
      { err, commandName },
      "Failed to upsert CLI capability graph node",
    );
  }
}

/**
 * Remove the graph node for a skill capability.
 */
export function deleteSkillCapabilityNode(skillId: string): void {
  try {
    const sourceKey = `${SKILL_SOURCE_PREFIX}${skillId}`;
    deleteCapabilityNode(sourceKey);
  } catch (err) {
    log.warn({ err, skillId }, "Failed to delete skill capability graph node");
  }
}

/**
 * Seed graph nodes for all enabled skills.
 * Prunes stale nodes whose skills are no longer enabled.
 */
export function seedSkillGraphNodes(): void {
  try {
    const catalog = loadSkillCatalog();
    const config = getConfig();
    const resolved = resolveSkillStates(catalog, config);
    const enabled = resolved.filter((r) => r.state === "enabled");

    const seenKeys = new Set<string>();
    for (const { summary } of enabled) {
      const input = fromSkillSummary(summary);

      if (summary.id === "mcp-setup") {
        const servers = config.mcp?.servers;
        if (servers) {
          const names = Object.keys(servers).filter(
            (name: string) => servers[name]?.enabled !== false,
          );
          if (names.length > 0) {
            input.description += ` Configured: ${names.join(", ")}`;
          }
        }
      }

      upsertSkillCapabilityNode(summary.id, input);
      seenKeys.add(`${SKILL_SOURCE_PREFIX}${summary.id}`);
    }

    pruneStaleCapabilities(SKILL_SOURCE_PREFIX, seenKeys);
  } catch (err) {
    log.warn({ err }, "Failed to seed skill graph nodes");
  }
}

/**
 * Seed graph nodes for all CLI commands.
 * Prunes stale nodes whose commands are no longer registered.
 */
export function seedCliGraphNodes(): void {
  try {
    const program = buildCliProgram();

    const seenKeys = new Set<string>();
    for (const cmd of program.commands) {
      upsertCliCapabilityNode(cmd.name(), cmd.description());
      seenKeys.add(`${CLI_SOURCE_PREFIX}${cmd.name()}`);
    }

    pruneStaleCapabilities(CLI_SOURCE_PREFIX, seenKeys);
  } catch (err) {
    log.warn({ err }, "Failed to seed CLI graph nodes");
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSkillContent(input: SkillCapabilityInput): string {
  let content = `The "${input.displayName}" skill (${input.id}) is available. ${input.description}.`;
  if (input.activationHints && input.activationHints.length > 0) {
    content += ` Use when: ${input.activationHints.join("; ")}.`;
  }
  if (input.avoidWhen && input.avoidWhen.length > 0) {
    content += ` Avoid when: ${input.avoidWhen.join("; ")}.`;
  }
  if (content.length > 500) {
    content = content.slice(0, 500);
  }
  return content;
}

/**
 * Core upsert: find an existing capability node by its sourceKey,
 * create or update as needed.
 *
 * We store the sourceKey in sourceConversations[0] as a stable identifier
 * (capability nodes aren't tied to a real conversation).
 */
function upsertCapabilityNode(sourceKey: string, content: string): void {
  const db = getDb();

  // Find existing node by sourceKey stored in source_conversations JSON
  const existing = db
    .select()
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.scopeId, "default"),
        like(memoryGraphNodes.sourceConversations, `%${sourceKey}%`),
      ),
    )
    .get();

  const now = Date.now();

  if (existing) {
    if (existing.content === content && existing.fidelity !== "gone") {
      // Same content — just touch lastAccessed
      db.update(memoryGraphNodes)
        .set({ lastAccessed: now })
        .where(eq(memoryGraphNodes.id, existing.id))
        .run();
      return;
    }

    // Content changed or was deleted — update
    db.update(memoryGraphNodes)
      .set({
        content,
        fidelity: "vivid",
        lastAccessed: now,
      })
      .where(eq(memoryGraphNodes.id, existing.id))
      .run();
    enqueueMemoryJob("embed_graph_node", { nodeId: existing.id });
    return;
  }

  // Create new capability node
  const node = createNode({
    content,
    type: "procedural" as const,
    created: now,
    lastAccessed: now,
    lastConsolidated: 0,
    emotionalCharge: {
      valence: 0,
      intensity: 0,
      decayCurve: "permanent" as const,
      decayRate: 0,
      originalIntensity: 0,
    },
    fidelity: "vivid" as const,
    confidence: 1.0,
    significance: 0.3,
    stability: 1000, // Effectively permanent — never decays
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [sourceKey],
    sourceType: "direct" as const,
    narrativeRole: null,
    partOfStory: null,
    scopeId: "default",
  });

  enqueueMemoryJob("embed_graph_node", { nodeId: node.id });
}

/**
 * Soft-delete (mark as gone) a capability node by its sourceKey.
 */
function deleteCapabilityNode(sourceKey: string): void {
  const db = getDb();
  const existing = db
    .select()
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.scopeId, "default"),
        like(memoryGraphNodes.sourceConversations, `%${sourceKey}%`),
      ),
    )
    .get();

  if (existing && existing.fidelity !== "gone") {
    db.update(memoryGraphNodes)
      .set({ fidelity: "gone", lastAccessed: Date.now() })
      .where(eq(memoryGraphNodes.id, existing.id))
      .run();
  }
}

/**
 * Remove capability nodes whose sourceKeys are no longer in the active set.
 */
function pruneStaleCapabilities(prefix: string, activeKeys: Set<string>): void {
  const db = getDb();
  const allCapabilities = db
    .select()
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.scopeId, "default"),
        like(memoryGraphNodes.sourceConversations, `%${prefix}%`),
      ),
    )
    .all();

  const now = Date.now();
  for (const row of allCapabilities) {
    if (row.fidelity === "gone") continue;

    // Extract sourceKey from JSON
    try {
      const sources = JSON.parse(row.sourceConversations as string);
      const key = Array.isArray(sources) ? sources[0] : null;
      if (key && typeof key === "string" && !activeKeys.has(key)) {
        db.update(memoryGraphNodes)
          .set({ fidelity: "gone", lastAccessed: now })
          .where(eq(memoryGraphNodes.id, row.id))
          .run();
      }
    } catch {
      // Skip malformed JSON
    }
  }
}
