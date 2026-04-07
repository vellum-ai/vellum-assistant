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

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
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
      let stat: ReturnType<typeof lstatSync>;
      try {
        // Use lstat (not stat) so symlinks are NOT dereferenced. Without
        // this, a symlink cycle inside a conversation directory (e.g.
        // `loop -> .`) would cause the walker to recurse forever and
        // hang `collectWorkspaceData`. With lstat, symlinks show up as
        // symlinks — neither `isDirectory()` nor `isFile()` is true on
        // the lstat result, so they're naturally skipped below.
        stat = lstatSync(child);
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

/**
 * Scan a conversation's `messages.jsonl` file and report whether any
 * message's `ts` (an ISO 8601 string written by `conversation-disk-view`)
 * falls inside the `[startTime, endTime]` window.
 *
 * Returns:
 *   - `true`  if at least one message timestamp lies in the window.
 *   - `false` otherwise (including: file is missing, file is empty, every
 *     line fails to parse, or no parsed line lands in the window).
 *
 * Lines that fail to parse as JSON or whose `ts` is not a parseable date
 * are silently skipped — they shouldn't be able to make the function
 * throw, since the export pipeline must never crash on a malformed
 * conversation file.
 *
 * The scan bails out as soon as it finds the first matching message, so
 * the worst case for an in-window conversation is "one early hit", and
 * the worst case for an out-of-window conversation is "read the whole
 * file once". Files are bounded by the workspace cap so this is safe.
 */
function conversationHasMessageInWindow(
  conversationDir: string,
  startTime: number | undefined,
  endTime: number | undefined,
): boolean {
  // No window means every message trivially "matches", but the only
  // caller (`collectConversations`) already short-circuits in that case
  // and never invokes this helper. Defensive check kept so the helper is
  // safe to reuse.
  if (startTime === undefined && endTime === undefined) return true;

  const messagesPath = join(conversationDir, "messages.jsonl");
  let raw: string;
  try {
    raw = readFileSync(messagesPath, "utf-8");
  } catch {
    // Missing or unreadable messages file → no in-window evidence.
    return false;
  }

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let record: { ts?: unknown };
    try {
      record = JSON.parse(line) as { ts?: unknown };
    } catch {
      continue;
    }
    if (typeof record.ts !== "string") continue;
    const ms = Date.parse(record.ts);
    if (Number.isNaN(ms)) continue;
    if (startTime !== undefined && ms < startTime) continue;
    if (endTime !== undefined && ms > endTime) continue;
    return true;
  }
  return false;
}

function collectConversations(
  opts: CollectWorkspaceDataOptions,
  result: CollectWorkspaceDataResult,
): void {
  const maxBytes = opts.maxBytes ?? MAX_WORKSPACE_PAYLOAD_BYTES;
  // Initialize the entry summary and push it onto `result.entries`
  // immediately so the conversations entry is always present in the
  // result, even if the candidate loop below throws partway through.
  // The array holds a reference to this object, so all later mutations
  // to `entry.itemCount`, `entry.bytes`, and `entry.skippedDueToCap`
  // are visible to consumers via `result.entries`.
  const entry = {
    entry: "conversations",
    itemCount: 0,
    bytes: 0,
    skippedDueToCap: 0,
  };
  result.entries.push(entry);

  const sourceDir = getConversationsDir();
  if (!existsSync(sourceDir)) {
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
    return;
  }

  const destBase = join(opts.staging, "workspace", "conversations");

  // First pass: parse + filter all names and collect the surviving
  // candidates so we can sort them deterministically before applying the
  // byte cap. Without this, `readdirSync` order determines which
  // conversations are dropped on truncation, which both makes capped
  // exports nondeterministic and can drop the newest conversations.
  const candidates: Array<{
    name: string;
    parsed: { conversationId: string; createdAtMs: number };
  }> = [];
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

    // Time-window filter: keep the conversation if EITHER its createdAt
    // (parsed from the directory name) OR any individual message inside
    // `messages.jsonl` falls in the requested window. This is the union
    // semantics — a conversation that was started before the window but
    // received messages during it should still ship, since the user
    // running an export almost always wants to see the activity that
    // happened during the window, not just conversations that were
    // _created_ in it.
    if (opts.startTime !== undefined || opts.endTime !== undefined) {
      const createdAtInWindow =
        (opts.startTime === undefined ||
          parsed.createdAtMs >= opts.startTime) &&
        (opts.endTime === undefined || parsed.createdAtMs <= opts.endTime);
      if (!createdAtInWindow) {
        // Fall back to scanning messages.jsonl for in-window activity.
        // This is more expensive than the directory-name parse, so we
        // only do it when the cheap check failed.
        const conversationDir = join(sourceDir, name);
        let hasMessageInWindow: boolean;
        try {
          hasMessageInWindow = conversationHasMessageInWindow(
            conversationDir,
            opts.startTime,
            opts.endTime,
          );
        } catch (err) {
          log.warn(
            { err, conversationDir },
            "Failed to scan messages.jsonl for window match; skipping",
          );
          continue;
        }
        if (!hasMessageInWindow) continue;
      }
    }

    candidates.push({ name, parsed });
  }

  // Newest first so cap-truncation keeps the most recent conversations.
  candidates.sort((a, b) => b.parsed.createdAtMs - a.parsed.createdAtMs);

  for (const { name } of candidates) {
    const srcPath = join(sourceDir, name);

    // Guard: a canonical-looking entry must be a real directory under
    // `conversations/`. Use `lstatSync` (not `statSync`) so symlinks are
    // not dereferenced — a symlink with a canonical name pointing at an
    // external directory must not be allowed to escape the allowlist
    // boundary. Symlinks are rejected explicitly below; regular files
    // (and anything else that isn't a directory) are also skipped so
    // `dirSizeWithinBudget` and `cpSync` never see them.
    let srcStat: ReturnType<typeof lstatSync>;
    try {
      srcStat = lstatSync(srcPath);
    } catch (err) {
      log.warn({ err, srcPath }, "Failed to stat conversation entry; skipping");
      continue;
    }
    if (srcStat.isSymbolicLink()) {
      log.warn(
        { srcPath },
        "Conversation entry is a symbolic link; skipping to preserve allowlist boundary",
      );
      continue;
    }
    if (!srcStat.isDirectory()) {
      log.warn({ srcPath }, "Conversation entry is not a directory; skipping");
      continue;
    }

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
