import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db.js";
import { computeMemoryFingerprint } from "../memory/fingerprint.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { memoryItems } from "../memory/schema.js";
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

/**
 * Upsert a capability memory item for a CLI command.
 * Best-effort: errors are logged but never thrown.
 */
export function upsertCliCapabilityMemory(
  commandName: string,
  description: string,
): void {
  try {
    const db = getDb();
    const subject = `cli:${commandName}`;
    const statement = buildCliCapabilityStatement(commandName, description);
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
    log.warn({ err, commandName }, "Failed to upsert CLI capability memory");
  }
}

/**
 * Seed capability memory items for all CLI commands.
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
      if (!item.subject.startsWith("cli:")) continue;
      const itemCommandName = item.subject.replace("cli:", "");
      if (!commandNames.has(itemCommandName)) {
        db.update(memoryItems)
          .set({ status: "deleted", lastSeenAt: now })
          .where(eq(memoryItems.id, item.id))
          .run();
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to seed CLI command memories");
  }
}
