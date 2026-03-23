import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/**
 * Return a human-readable relative timestamp from a Unix-epoch millisecond
 * value to "now".
 */
export function formatJournalRelativeTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
  }

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
  }

  const diffWeeks = Math.floor(diffDays / 7);
  return diffWeeks === 1 ? "1 week ago" : `${diffWeeks} weeks ago`;
}

/**
 * Build a journal context section for inclusion in the system prompt.
 *
 * Reads `{workspaceDir}/journal/*.md` files, sorts by mtime (newest first),
 * and returns a formatted string with relative timestamps. Returns `null`
 * when no entries are available.
 */
export function buildJournalContext(maxEntries: number): string | null {
  if (maxEntries <= 0) return null;

  const journalDir = join(getWorkspaceDir(), "journal");

  let files: string[];
  try {
    files = readdirSync(journalDir);
  } catch {
    // Directory doesn't exist — no journal entries
    return null;
  }

  // Filter for .md files, excluding README.md (case-insensitive)
  const mdFiles = files.filter(
    (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
  );

  // Collect file info with mtime
  const entries = mdFiles
    .map((f) => {
      const filepath = join(journalDir, f);
      const stat = statSync(filepath);
      return { filename: f, filepath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxEntries);

  if (entries.length === 0) return null;

  const sections: string[] = [
    "# Journal\n\nYour journal entries, most recent first. These are YOUR words from past conversations.",
  ];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const content = readFileSync(entry.filepath, "utf-8");
    const relativeTime = formatJournalRelativeTime(entry.mtimeMs);

    let header: string;
    if (i === 0) {
      header = `## ${entry.filename} — MOST RECENT (${relativeTime})`;
    } else if (i === entries.length - 1 && entries.length === maxEntries) {
      header = `## ${entry.filename} — LEAVING CONTEXT (${relativeTime})`;
      header +=
        "\nNOTE: This is the oldest entry in your active context. When you write your next journal entry, carry forward anything from here that still matters to you — after that, this entry will only be available via the filesystem and memory recall.";
      header += "\n";
    } else {
      header = `## ${entry.filename} (${relativeTime})`;
    }

    sections.push(header + "\n" + content);
  }

  return sections.join("\n\n");
}
