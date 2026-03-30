import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { getMemoryCheckpoint } from "../memory/checkpoints.js";
import {
  enqueueMemoryJob,
  hasActiveCarryForwardJob,
} from "../memory/jobs-store.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("journal-context");

/**
 * Format a Unix-epoch millisecond value as "MM/DD/YY HH:MM".
 */
export function formatJournalAbsoluteTime(mtime: number): string {
  const d = new Date(mtime);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${yy} ${hh}:${min}`;
}

/**
 * Build a journal context section for inclusion in the system prompt.
 *
 * Reads `{workspaceDir}/journal/*.md` files, sorts by creation time
 * (newest first), and returns a formatted string with timestamps.
 * Returns `null` when no entries are available.
 */
export function buildJournalContext(
  maxEntries: number,
  userSlug?: string | null,
): string | null {
  if (maxEntries <= 0) return null;

  // When no user is identified, skip journal entirely
  let journalDir: string;
  if (userSlug != null) {
    // Sanitize slug to prevent path traversal
    const safeSlug = basename(userSlug);
    journalDir = join(getWorkspaceDir(), "journal", safeSlug);
  } else {
    return null;
  }

  let files: string[];
  try {
    files = readdirSync(journalDir);
  } catch {
    // Directory doesn't exist — no journal entries
    return null;
  }

  // Filter for .md files, excluding README.md (case-insensitive)
  const mdFiles = files.filter(
    (f) =>
      f.endsWith(".md") &&
      !f.startsWith(".") &&
      f.toLowerCase() !== "readme.md",
  );

  // Collect file info with birthtime (creation time), skipping unreadable entries
  const allEntries = mdFiles
    .flatMap((f) => {
      try {
        const filepath = join(journalDir, f);
        const stat = statSync(filepath);
        if (!stat.isFile()) return [];
        // Fall back to mtimeMs when birthtimeMs is unavailable (returns 0 on Linux ext4, NFS, Docker overlayfs)
        const birthtimeMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
        return [{ filename: f, filepath, birthtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.birthtimeMs - a.birthtimeMs);

  const entries = allEntries.slice(0, maxEntries);
  const rotatingOut = allEntries.slice(maxEntries);

  // Enqueue carry-forward jobs for entries rotating out of the context window.
  // Wrapped in try-catch so DB errors never break journal context rendering.
  if (rotatingOut.length > 0 && userSlug != null) {
    try {
      const safeSlug = basename(userSlug) || "unknown";
      for (const entry of rotatingOut) {
        const checkpointKey = `journal_carry_forward:${safeSlug}:${entry.filename}`;
        if (getMemoryCheckpoint(checkpointKey) != null) continue;
        if (hasActiveCarryForwardJob(entry.filename, safeSlug)) continue;

        let content: string;
        try {
          content = readFileSync(entry.filepath, "utf-8");
        } catch {
          continue;
        }

        enqueueMemoryJob("journal_carry_forward", {
          journalContent: content,
          userSlug: safeSlug,
          filename: entry.filename,
          scopeId: "default",
        });
        log.info(
          { filename: entry.filename, userSlug: safeSlug },
          "Enqueued journal carry-forward job for rotating-out entry",
        );
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to enqueue journal carry-forward jobs",
      );
    }
  }

  if (entries.length === 0) return null;

  const sections: string[] = [
    `# Journal\n\nYour journal entries, most recent first. These are YOUR words from past conversations.\n**Write new entries to:** \`journal/${basename(userSlug!)}/\``,
  ];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let content: string;
    try {
      content = readFileSync(entry.filepath, "utf-8");
    } catch {
      continue;
    }
    const timestamp = formatJournalAbsoluteTime(entry.birthtimeMs);

    let header: string;
    if (i === 0) {
      header = `## ${entry.filename} — MOST RECENT (${timestamp})`;
    } else if (i === entries.length - 1 && entries.length === maxEntries) {
      header = `## ${entry.filename} — LEAVING CONTEXT (${timestamp})`;
      header +=
        "\nNOTE: This is the oldest entry in your active context. When you write your next journal entry, carry forward anything from here that still matters to you — after that, this entry will only be available via the filesystem and memory recall.";
      header += "\n";
    } else {
      header = `## ${entry.filename} (${timestamp})`;
    }

    sections.push(header + "\n" + content);
  }

  // If all readFileSync calls failed, sections only contains the header — return null
  if (sections.length === 1) return null;

  return sections.join("\n\n");
}
