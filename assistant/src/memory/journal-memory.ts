import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getWorkspaceDir } from "../util/platform.js";
import { getLogger } from "../util/logger.js";
import { getDb } from "./db.js";
import { computeMemoryFingerprint } from "./fingerprint.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { memoryItems, memoryItemSources } from "./schema.js";

const log = getLogger("memory-journal");

/**
 * Scan the journal directory for `.md` files created during (or after) the
 * given message timestamp and upsert them as journal memory items with the
 * raw, unedited file content as the `statement`.
 *
 * This bypasses the LLM extraction layer entirely — journal memories are
 * stored verbatim so they are never summarised or rewritten.
 *
 * Returns the number of newly inserted items.
 */
export function upsertJournalMemoriesFromDisk(
  messageCreatedAt: number,
  scopeId: string,
  messageId: string,
): number {
  try {
    const journalDir = join(getWorkspaceDir(), "journal");

    let files: string[];
    try {
      files = readdirSync(journalDir);
    } catch {
      // Directory doesn't exist — no journal entries
      return 0;
    }

    // Filter for .md files, excluding readme.md (case-insensitive)
    const mdFiles = files.filter(
      (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
    );

    let upserted = 0;
    const db = getDb();

    for (const filename of mdFiles) {
      try {
        const filepath = join(journalDir, filename);
        const stat = statSync(filepath);
        if (!stat.isFile()) continue;

        // Only process files created during or after this message
        if (stat.birthtimeMs < messageCreatedAt) continue;

        const content = readFileSync(filepath, "utf-8");

        // Derive subject from filename:
        // strip .md extension, strip leading date prefix, replace hyphens with spaces, capitalize first letter
        const basename = filename.replace(/\.md$/, "");
        const withoutDate = basename.replace(/^\d{4}-\d{2}-\d{2}-?/, "");
        const withSpaces = withoutDate.replace(/-/g, " ");
        const subject =
          withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);

        const fingerprint = computeMemoryFingerprint(
          scopeId,
          "journal",
          subject,
          content,
        );

        const existing = db
          .select()
          .from(memoryItems)
          .where(
            and(
              eq(memoryItems.fingerprint, fingerprint),
              eq(memoryItems.scopeId, scopeId),
            ),
          )
          .get();

        let memoryItemId: string;

        if (existing) {
          memoryItemId = existing.id;
          db.update(memoryItems)
            .set({
              lastSeenAt: messageCreatedAt,
              status: "active",
            })
            .where(eq(memoryItems.id, existing.id))
            .run();
        } else {
          memoryItemId = uuid();
          db.insert(memoryItems)
            .values({
              id: memoryItemId,
              kind: "journal",
              subject,
              statement: content,
              status: "active",
              confidence: 0.95,
              importance: 0.8,
              fingerprint,
              sourceType: "extraction",
              sourceMessageRole: "assistant",
              verificationState: "assistant_inferred",
              scopeId,
              firstSeenAt: messageCreatedAt,
              lastSeenAt: messageCreatedAt,
              lastUsedAt: null,
              supersedes: null,
              overrideConfidence: null,
            })
            .run();
          upserted += 1;
        }

        db.insert(memoryItemSources)
          .values({
            memoryItemId,
            messageId,
            evidence: content,
            createdAt: Date.now(),
          })
          .onConflictDoNothing()
          .run();

        enqueueMemoryJob("embed_item", { itemId: memoryItemId });
      } catch (err) {
        log.warn(
          { filename, err: err instanceof Error ? err.message : String(err) },
          "Failed to process journal file for memory — skipping",
        );
      }
    }

    return upserted;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to scan journal directory for memories",
    );
    return 0;
  }
}
