import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { resolveSkillStates } from "../config/skill-state.js";
import { loadSkillCatalog, type SkillSummary } from "../config/skills.js";
import { getDb } from "../memory/db.js";
import { computeMemoryFingerprint } from "../memory/fingerprint.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { memoryItems } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";

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
  };
}

/**
 * Build a semantically rich capability statement from a skill capability input.
 * Truncated to 500 chars max (matching the limit used by memory item extraction).
 */
export function buildCapabilityStatement(input: SkillCapabilityInput): string {
  const { displayName, activationHints } = input;

  let statement = `The "${displayName}" skill (${input.id}) is available. ${input.description}.`;
  if (activationHints && activationHints.length > 0) {
    statement += ` Use when: ${activationHints.join("; ")}.`;
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
      upsertSkillCapabilityMemory(summary.id, fromSkillSummary(summary));
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

    const now = Date.now();
    for (const item of allCapabilities) {
      if (!item.subject.startsWith("skill:")) continue;
      const itemSkillId = item.subject.replace("skill:", "");
      if (!catalogIds.has(itemSkillId)) {
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
