import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { resolveSkillStates } from "../config/skill-state.js";
import { loadSkillCatalog, type SkillSummary } from "../config/skills.js";
import { getDb } from "../memory/db.js";
import { computeMemoryFingerprint } from "../memory/fingerprint.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { memoryItems } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import {
  getCachedCatalogSync,
  isCatalogCachePopulated,
} from "./catalog-cache.js";
import type { CatalogSkill } from "./catalog-install.js";

const log = getLogger("skill-memory");

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
 * Convert a CatalogSkill to a SkillCapabilityInput.
 * CatalogSkill stores display-name and hints inside nested metadata.
 */
export function fromCatalogSkill(entry: CatalogSkill): SkillCapabilityInput {
  return {
    id: entry.id,
    displayName: entry.metadata?.vellum?.["display-name"] ?? entry.name,
    description: entry.description,
    activationHints: entry.metadata?.vellum?.["activation-hints"],
    avoidWhen: entry.metadata?.vellum?.["avoid-when"],
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

/**
 * Upsert a capability memory item for a skill.
 * Best-effort: errors are logged but never thrown.
 */
export function upsertSkillCapabilityMemory(
  skillId: string,
  input: SkillCapabilityInput,
): void {
  try {
    const db = getDb();
    const subject = `skill:${skillId}`;
    const statement = buildCapabilityStatement(input);
    const kind = "capability";
    const scopeId = "default";
    const confidence = 1.0;
    const importance = 0.7;
    const fingerprint = computeMemoryFingerprint(
      scopeId,
      kind,
      subject,
      statement,
    );
    const now = Date.now();

    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.kind, kind),
          eq(memoryItems.subject, subject),
          eq(memoryItems.scopeId, scopeId),
        ),
      )
      .get();

    if (existing) {
      if (
        existing.status === "active" &&
        existing.fingerprint === fingerprint
      ) {
        // Same content — just touch lastSeenAt
        db.update(memoryItems)
          .set({ lastSeenAt: now })
          .where(eq(memoryItems.id, existing.id))
          .run();
        return;
      }

      if (existing.status === "active") {
        // Content changed — update statement and fingerprint
        db.update(memoryItems)
          .set({
            statement,
            fingerprint,
            lastSeenAt: now,
          })
          .where(eq(memoryItems.id, existing.id))
          .run();
        enqueueMemoryJob("embed_item", { itemId: existing.id });
        return;
      }

      // status === "deleted" or other — reactivate
      db.update(memoryItems)
        .set({
          status: "active",
          statement,
          fingerprint,
          lastSeenAt: now,
          firstSeenAt: now,
        })
        .where(eq(memoryItems.id, existing.id))
        .run();
      enqueueMemoryJob("embed_item", { itemId: existing.id });
      return;
    }

    // No existing — insert new row
    const id = uuid();
    db.insert(memoryItems)
      .values({
        id,
        kind,
        subject,
        statement,
        status: "active",
        confidence,
        importance,
        fingerprint,
        sourceType: "extraction",
        scopeId,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    enqueueMemoryJob("embed_item", { itemId: id });
  } catch (err) {
    log.warn({ err, skillId }, "Failed to upsert skill capability memory");
  }
}

/**
 * Soft-delete the capability memory item for a skill.
 * Best-effort: errors are logged but never thrown.
 */
export function deleteSkillCapabilityMemory(skillId: string): void {
  try {
    const db = getDb();
    const subject = `skill:${skillId}`;
    const now = Date.now();

    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.kind, "capability"),
          eq(memoryItems.subject, subject),
          eq(memoryItems.scopeId, "default"),
        ),
      )
      .get();

    if (existing && existing.status !== "deleted") {
      db.update(memoryItems)
        .set({ status: "deleted", lastSeenAt: now })
        .where(eq(memoryItems.id, existing.id))
        .run();
    }
  } catch (err) {
    log.warn({ err, skillId }, "Failed to delete skill capability memory");
  }
}

/**
 * Seed capability memory items for all enabled skills (bundled, managed, workspace, extra).
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
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.kind, "capability"),
          eq(memoryItems.scopeId, "default"),
          eq(memoryItems.status, "active"),
        ),
      )
      .all();

    const cachedCatalogIds = new Set(
      getCachedCatalogSync().map((s) => s.id),
    );
    // When the catalog cache hasn't been populated yet, skip pruning
    // uninstalled catalog skill memories to avoid a wasteful
    // soft-delete → re-create → re-embed cycle on every startup.
    const cachePopulated = isCatalogCachePopulated();

    const now = Date.now();
    for (const item of allCapabilities) {
      if (!item.subject.startsWith("skill:")) continue;
      const itemSkillId = item.subject.replace("skill:", "");
      if (
        !catalogIds.has(itemSkillId) &&
        cachePopulated &&
        !cachedCatalogIds.has(itemSkillId)
      ) {
        db.update(memoryItems)
          .set({ status: "deleted", lastSeenAt: now })
          .where(eq(memoryItems.id, item.id))
          .run();
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to seed catalog skill memories");
  }
}

/**
 * Seed capability memories for catalog skills that are not yet installed.
 * This makes uninstalled skills discoverable via memory injection so the LLM
 * can auto-install them via skill_load when relevant.
 * Best-effort: errors are logged but never thrown.
 */
export async function seedUninstalledCatalogSkillMemories(): Promise<void> {
  try {
    const { getCatalog } = await import("./catalog-cache.js");
    const fullCatalog = await getCatalog();
    if (fullCatalog.length === 0) return;

    const installedCatalog = loadSkillCatalog();
    const installedIds = new Set(installedCatalog.map((s) => s.id));

    const config = getConfig();
    for (const entry of fullCatalog) {
      if (installedIds.has(entry.id)) continue;

      const flagKey = entry.metadata?.vellum?.["feature-flag"];
      if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) continue;

      const input = fromCatalogSkill(entry);
      upsertSkillCapabilityMemory(entry.id, input);
    }
  } catch (err) {
    log.warn({ err }, "Failed to seed uninstalled catalog skill memories");
  }
}
