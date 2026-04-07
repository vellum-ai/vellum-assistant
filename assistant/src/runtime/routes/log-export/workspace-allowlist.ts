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
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

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
 * Chunk size used by the streaming `messages.jsonl` reader. 64 KB is
 * large enough to amortize syscall overhead but small enough to keep
 * the synchronous read path off the event loop for any meaningful
 * stretch.
 */
const MESSAGES_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Check whether a single JSONL line records a message whose `ts` falls
 * in the `[startTime, endTime]` window. Returns `false` for malformed
 * lines, missing/wrong-typed `ts` fields, and dates outside the window.
 * Pulled out as a helper so the streaming reader can call it on each
 * decoded line without duplicating the parsing logic.
 */
function lineMatchesWindow(
  line: string,
  startTime: number | undefined,
  endTime: number | undefined,
): boolean {
  if (!line) return false;
  let record: { ts?: unknown };
  try {
    record = JSON.parse(line) as { ts?: unknown };
  } catch {
    return false;
  }
  if (typeof record.ts !== "string") return false;
  const ms = Date.parse(record.ts);
  if (Number.isNaN(ms)) return false;
  if (startTime !== undefined && ms < startTime) return false;
  if (endTime !== undefined && ms > endTime) return false;
  return true;
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
 * The reader streams the file in fixed-size chunks (`MESSAGES_SCAN_CHUNK_BYTES`)
 * via `readSync` and decodes UTF-8 across chunk boundaries with
 * `StringDecoder`. It bails out as soon as it finds the first matching
 * line, so the worst case for an in-window conversation is "one early
 * hit", and the worst case for an out-of-window conversation is "read
 * the whole file once" — without ever holding more than one chunk plus
 * one in-progress line in memory.
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
  let fd: number;
  try {
    fd = openSync(messagesPath, "r");
  } catch {
    // Missing or unreadable messages file → no in-window evidence.
    return false;
  }

  const buffer = Buffer.alloc(MESSAGES_SCAN_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let leftover = "";
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = leftover + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split("\n");
      // The last segment may be a partial line — hold it back for the
      // next chunk to complete.
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (lineMatchesWindow(line, startTime, endTime)) return true;
      }
    }
    // Drain any partial UTF-8 sequence the decoder is still holding,
    // then check the final unterminated line (the file may not end with
    // a newline).
    const tail = leftover + decoder.end();
    if (lineMatchesWindow(tail, startTime, endTime)) return true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort close */
    }
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

  // First pass: parse the name, apply the conversationId filter, validate
  // that the entry is a real directory (not a symlink, not a regular
  // file), then apply the time-window filter (which may need to read
  // `messages.jsonl`). Collect surviving candidates so we can sort them
  // deterministically before applying the byte cap.
  //
  // The non-directory / symlink validation happens BEFORE the message
  // scan so a canonical-named symlink can never coerce
  // `conversationHasMessageInWindow` into reading from outside the
  // `conversations/` boundary.
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

    const srcPath = join(sourceDir, name);

    // Boundary guard: a canonical-looking entry must be a real directory
    // under `conversations/`. Use `lstatSync` (not `statSync`) so
    // symlinks are not dereferenced — a symlink with a canonical name
    // pointing at an external directory must not be allowed to escape
    // the allowlist boundary, neither for the time-window message scan
    // below nor for the eventual `cpSync` copy. Symlinks and regular
    // files are rejected explicitly here so the message scan and the
    // copy loop only ever see real directories.
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
        // only do it when the cheap check failed. The boundary guard
        // above guarantees `srcPath` is a real in-allowlist directory,
        // so the file path the scanner reads stays inside the allowlist.
        let hasMessageInWindow: boolean;
        try {
          hasMessageInWindow = conversationHasMessageInWindow(
            srcPath,
            opts.startTime,
            opts.endTime,
          );
        } catch (err) {
          log.warn(
            { err, srcPath },
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
