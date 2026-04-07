/**
 * Workspace allowlist module for the daemon log export endpoint.
 *
 * `POST /v1/export` collects audit DB rows, daemon logs, and a sanitized
 * `config.json` snapshot. This module governs which subpaths of the user's
 * workspace directory (`~/.vellum/workspace/`) are *opted in* to the export
 * archive. The default is "nothing from the workspace ships" — every entry
 * here must be justified against the rules in `./AGENTS.md`.
 *
 * The first allowlisted entry is `<workspace>/conversations/`, which honors
 * both the time filter (via the parsed timestamp prefix on each conversation
 * directory name) and the conversationId filter (via exact match on the id
 * suffix). Directory names that don't match the canonical
 * `<ISO-with-dashes>_<conversationId>` format are silently skipped (Rule 3).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseConversationDirName } from "../../../memory/conversation-directories.js";
import { getLogger } from "../../../util/logger.js";
import { getConversationsDir } from "../../../util/platform.js";

const log = getLogger("log-export-workspace");

/**
 * Maximum total bytes that the workspace allowlist may contribute to a
 * single export archive. Mirrors `MAX_LOG_PAYLOAD_BYTES` in
 * `log-export-routes.ts` so that the workspace section can never blow past
 * the same 10 MB cap that already governs the daemon-logs section.
 */
export const MAX_WORKSPACE_PAYLOAD_BYTES = 10 * 1024 * 1024;

export interface CollectWorkspaceDataOptions {
  /** Absolute path of the export staging directory. */
  staging: string;
  /** When set, restrict allowlisted entries to this conversation. */
  conversationId?: string;
  /** Lower bound (epoch ms, inclusive). */
  startTime?: number;
  /** Upper bound (epoch ms, inclusive). */
  endTime?: number;
  /** Override the default 10 MB cap (used in tests). */
  maxBytes?: number;
}

export interface CollectWorkspaceDataResult {
  /** Allowlisted entries that were copied to staging/workspace/. */
  entries: Array<{
    /** Allowlist entry name (e.g. "conversations"). */
    entry: string;
    /** Number of items (files or subdirs) copied. */
    itemCount: number;
    /** Total bytes copied for this entry. */
    bytes: number;
    /** Items skipped because the cap would be exceeded. */
    skippedDueToCap: number;
  }>;
  totalBytes: number;
}

/**
 * Walk a directory recursively and sum the sizes of every regular file
 * underneath it. Bails out early once the running total would push the
 * workspace cap over `remainingBudget` bytes — that way we never burn
 * cycles totalling a multi-gigabyte directory only to discard it.
 *
 * Returns `null` to signal "this directory is too big to fit in the
 * remaining budget"; returns the exact byte total otherwise.
 */
function dirSizeWithinBudget(
  rootDir: string,
  remainingBudget: number,
): number | null {
  let total = 0;
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (err) {
      log.warn(
        { err, dir: current },
        "Failed to read workspace directory while sizing; skipping",
      );
      continue;
    }
    for (const name of entries) {
      const child = join(current, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(child);
      } catch (err) {
        log.warn(
          { err, path: child },
          "Failed to stat workspace path while sizing; skipping",
        );
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(child);
      } else if (stat.isFile()) {
        total += stat.size;
        if (total > remainingBudget) {
          return null;
        }
      }
    }
  }
  return total;
}

function collectConversations(
  opts: CollectWorkspaceDataOptions,
  result: CollectWorkspaceDataResult,
): void {
  const maxBytes = opts.maxBytes ?? MAX_WORKSPACE_PAYLOAD_BYTES;
  const entry = {
    entry: "conversations",
    itemCount: 0,
    bytes: 0,
    skippedDueToCap: 0,
  };

  const sourceDir = getConversationsDir();
  if (!existsSync(sourceDir)) {
    result.entries.push(entry);
    return;
  }

  let names: string[];
  try {
    names = readdirSync(sourceDir);
  } catch (err) {
    log.warn(
      { err, sourceDir },
      "Failed to read conversations directory; skipping conversations entry",
    );
    result.entries.push(entry);
    return;
  }

  const destBase = join(opts.staging, "workspace", "conversations");

  for (const name of names) {
    let parsed: ReturnType<typeof parseConversationDirName>;
    try {
      parsed = parseConversationDirName(name);
    } catch (err) {
      log.warn(
        { err, name },
        "Failed to parse conversation directory name; skipping",
      );
      continue;
    }
    if (!parsed) continue; // Rule 3 — default deny non-canonical names.

    if (
      opts.conversationId !== undefined &&
      parsed.conversationId !== opts.conversationId
    ) {
      continue;
    }
    if (opts.startTime !== undefined && parsed.createdAtMs < opts.startTime) {
      continue;
    }
    if (opts.endTime !== undefined && parsed.createdAtMs > opts.endTime) {
      continue;
    }

    const srcPath = join(sourceDir, name);
    const remainingBudget = maxBytes - result.totalBytes;
    let dirBytes: number | null;
    try {
      dirBytes = dirSizeWithinBudget(srcPath, remainingBudget);
    } catch (err) {
      log.warn(
        { err, srcPath },
        "Failed to compute conversation directory size; skipping",
      );
      continue;
    }

    if (dirBytes === null) {
      // Including this directory would exceed the workspace cap.
      entry.skippedDueToCap += 1;
      continue;
    }

    try {
      mkdirSync(destBase, { recursive: true });
      cpSync(srcPath, join(destBase, name), { recursive: true });
    } catch (err) {
      log.warn(
        { err, srcPath },
        "Failed to copy conversation directory; skipping",
      );
      continue;
    }

    entry.itemCount += 1;
    entry.bytes += dirBytes;
    result.totalBytes += dirBytes;
  }

  result.entries.push(entry);
}

/**
 * Collect allowlisted workspace data into `<staging>/workspace/`.
 *
 * Currently the only allowlisted entry is `conversations/`. Future entries
 * should follow the rules in `./AGENTS.md` (time filter, conversation
 * filter, byte cap, registry update). The function never throws — all
 * filesystem errors are logged at warn level so the rest of the export
 * pipeline can continue regardless.
 */
export function collectWorkspaceData(
  opts: CollectWorkspaceDataOptions,
): CollectWorkspaceDataResult {
  const result: CollectWorkspaceDataResult = {
    entries: [],
    totalBytes: 0,
  };

  try {
    collectConversations(opts, result);
  } catch (err) {
    log.warn(
      { err },
      "Unexpected error while collecting workspace conversations entry",
    );
  }

  log.info(
    {
      entries: result.entries,
      totalBytes: result.totalBytes,
      conversationId: opts.conversationId ?? null,
      startTime: opts.startTime ?? null,
      endTime: opts.endTime ?? null,
    },
    "Workspace allowlist collection complete",
  );

  return result;
}
