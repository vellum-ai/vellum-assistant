// ---------------------------------------------------------------------------
// Memory Graph — Capability seeding for skills and CLI commands
//
// Creates graph nodes for skill/CLI capabilities so they participate in
// semantic retrieval.
// ---------------------------------------------------------------------------

import { and, eq, like, sql } from "drizzle-orm";

import { buildCliProgram } from "../../cli/program.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { resolveSkillStates } from "../../config/skill-state.js";
import { loadSkillCatalog } from "../../config/skills.js";
import {
  getCachedCatalogSync,
  getCatalog,
} from "../../skills/catalog-cache.js";
import {
  fromCatalogSkill,
  fromSkillSummary,
  type SkillCapabilityInput,
} from "../../skills/skill-memory.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { enqueueMemoryJob } from "../jobs-store.js";
import { memoryGraphNodes } from "../schema.js";
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

    // Protect uninstalled catalog skills from pruning — they are seeded
    // asynchronously by seedUninstalledCatalogSkillMemories() and should
    // not be marked as "gone" just because they aren't locally installed.
    // Only include catalog entries whose feature-flag is enabled, matching
    // the filter in seedUninstalledCatalogSkillMemories().
    const cachedCatalog = getCachedCatalogSync();
    for (const entry of cachedCatalog) {
      const flagKey = entry.metadata?.vellum?.["feature-flag"];
      if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) continue;
      seenKeys.add(`${SKILL_SOURCE_PREFIX}${entry.id}`);
    }

    pruneStaleCapabilities(SKILL_SOURCE_PREFIX, seenKeys);

    // Clean up old-format nodes created by the legacy skill-memory.ts system.
    // Those nodes have content like "skill:{id}\n..." instead of the current
    // 'The "..." skill ...' format. Mark them as gone so they stop appearing
    // as duplicates. Idempotent — once cleaned, subsequent runs find nothing.
    cleanupOldFormatSkillNodes();
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

/**
 * Seed capability graph nodes for catalog skills that are not yet installed.
 * This makes uninstalled skills discoverable via memory injection so the LLM
 * can auto-install them via skill_load when relevant.
 * Best-effort: errors are logged but never thrown.
 */
export async function seedUninstalledCatalogSkillMemories(): Promise<void> {
  try {
    const fullCatalog = await getCatalog();
    if (fullCatalog.length === 0) return;

    const installedCatalog = loadSkillCatalog();
    const installedIds = new Set(installedCatalog.map((s) => s.id));

    const config = getConfig();
    for (const entry of fullCatalog) {
      if (installedIds.has(entry.id)) continue;

      const flagKey = entry.metadata?.vellum?.["feature-flag"];
      if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) continue;

      upsertSkillCapabilityNode(entry.id, fromCatalogSkill(entry));
    }
  } catch (err) {
    log.warn({ err }, "Failed to seed uninstalled catalog skill memories");
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
      // Same content — just touch lastAccessed (and backfill lastConsolidated
      // for nodes created before the fix so they don't decay immediately)
      const updates: Record<string, number> = { lastAccessed: now };
      if (existing.lastConsolidated === 0) updates.lastConsolidated = now;
      db.update(memoryGraphNodes)
        .set(updates)
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
        ...(existing.lastConsolidated === 0 ? { lastConsolidated: now } : {}),
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
    lastConsolidated: now,
    eventDate: null,
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
    imageRefs: null,
    scopeId: "default",
  });

  enqueueMemoryJob("embed_graph_node", { nodeId: node.id });
  log.info({ sourceKey, nodeId: node.id }, "Created capability graph node");
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
 * Find and soft-delete old-format skill memory nodes.
 *
 * The legacy skill-memory.ts system stored content as "skill:{id}\n{statement}".
 * The current system uses "The "..." skill ..." prose format. This marks any
 * remaining old-format nodes as gone so they no longer surface in retrieval.
 */
function cleanupOldFormatSkillNodes(): void {
  const db = getDb();

  const oldFormatNodes = db
    .select()
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.type, "procedural"),
        eq(memoryGraphNodes.scopeId, "default"),
        sql`${memoryGraphNodes.fidelity} != 'gone'`,
        sql`${memoryGraphNodes.content} LIKE 'skill:%'`,
      ),
    )
    .all();

  const now = Date.now();
  for (const node of oldFormatNodes) {
    // Verify this is truly old-format: "skill:{id}\n..."
    if (!/^skill:\S+\n/.test(node.content)) continue;

    db.update(memoryGraphNodes)
      .set({ fidelity: "gone", lastAccessed: now })
      .where(eq(memoryGraphNodes.id, node.id))
      .run();
    log.info({ nodeId: node.id }, "Cleaned up old-format skill memory node");
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
        log.info(
          { sourceKey: key, nodeId: row.id },
          "Pruning stale capability graph node",
        );
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
