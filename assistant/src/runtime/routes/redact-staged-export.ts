/**
 * Export-time secret sweep for the log export staging directory.
 *
 * `POST /v1/export` stages audit DB rows, daemon logs, a sanitized config
 * snapshot, and allowlisted workspace files before archiving them. The
 * structural sanitizers (write-time audit-input redaction, config snapshot
 * env scrubbing) only protect data written after they shipped — legacy audit
 * rows already persisted with plaintext inputs, and free-form workspace
 * conversation logs, can still carry raw secrets. This module is the final
 * belt: a pattern-based `redactSecrets()` pass over staged files immediately
 * before the tar.gz is created.
 *
 * Coverage: every staged file that sniffs as text (no NUL byte in its first
 * 8 KiB) is swept; files that sniff as binary are left untouched. That
 * single check covers everything the export stages as text today —
 * `audit-data.json`, `messages.json`, `config-snapshot.json`, daemon `.log`
 * files, `conversation-filtered.jsonl`, workspace copies
 * (`conversations/**\/messages.jsonl`, `.tool-results/*.txt`) — plus
 * conversation `attachments/` with arbitrary user extensions (`.env`,
 * `.csv`, extensionless). Serialized-JSON formats (`.json`, `.jsonl`) are
 * redacted via a parse → redact-string-leaves → re-stringify path so the
 * quoted redaction marker cannot corrupt them. Files above the size cap are
 * NOT shipped unswept: their content is replaced with a short omission note
 * (fail closed). Likewise, a file whose redacted content cannot be written
 * back is replaced with a note rather than shipped with its original bytes.
 */

import type { Dirent } from "node:fs";
import {
  chmodSync,
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import { redactJsonStringLeaves } from "../../security/redact-json.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("redact-staged-export");

/**
 * Files larger than this are not read into memory — the sweep reads each
 * file fully to redact it. Every staged section is bounded at the source
 * (row-capped DB dumps, the daemon-log payload cap, workspace copy caps), so
 * staged files sit well below this. Oversized sweep-eligible files fail
 * closed: their content is replaced with `OVERSIZED_FILE_NOTE` so legacy
 * plaintext secrets can never ship unswept.
 */
export const MAX_SWEEP_FILE_BYTES = 32 * 1024 * 1024;

/** Replacement content for files that exceed `MAX_SWEEP_FILE_BYTES`. */
export const OVERSIZED_FILE_NOTE = `[content omitted from export: file exceeded the ${
  MAX_SWEEP_FILE_BYTES / (1024 * 1024)
} MiB secret-redaction cap]\n`;

/**
 * Replacement content for files where redaction detected a secret but the
 * redacted content could not be written back in place.
 */
const UNWRITABLE_FILE_NOTE =
  "[content omitted from export: redaction detected a secret but could not rewrite this staged file]\n";

/**
 * Replace a staged file's content with a short omission note. Removal +
 * recreation is a directory-level operation, so it succeeds regardless of
 * the file's own mode bits (the staging dir is daemon-created and writable).
 * Throws if the replacement fails — callers rely on that to fail closed
 * rather than letting the tar step ship the original content.
 */
function replaceFileWithNote(filePath: string, note: string): void {
  rmSync(filePath, { force: true });
  writeFileSync(filePath, note, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Bytes read from the head of each staged file to classify it as text
 * (sweep it) or binary (leave it untouched).
 */
const TEXT_SNIFF_BYTES = 8 * 1024;

/**
 * Heuristic text check: a file is treated as text when its first
 * `TEXT_SNIFF_BYTES` contain no NUL byte. Binary formats (images, archives,
 * SQLite, …) virtually always carry a NUL early; redacting them as text
 * would corrupt them for no benefit.
 */
function sniffsAsText(filePath: string): boolean {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_SNIFF_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Redact a serialized-JSON document while preserving its validity: parse,
 * redact every string leaf, and re-stringify with `indent` (unchanged text
 * is returned byte-identical). A leading UTF-8 BOM — common in user
 * attachments — would make `JSON.parse` throw, so it is stripped for parsing
 * and re-prepended on changed output to keep the content faithful. Falls
 * back to plain-text redaction when the text isn't valid JSON — it is
 * already malformed, so there is no validity to preserve.
 */
function redactSerializedJson(text: string, indent?: number): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(bom ? text.slice(1) : text);
  } catch {
    return redactSecrets(text);
  }
  const { value, changed } = redactJsonStringLeaves(parsed);
  return changed ? bom + JSON.stringify(value, null, indent) : text;
}

/**
 * Redact a `.jsonl` file's content line by line, preserving each line's
 * JSON validity (compact re-stringify, no pretty-printing). Unchanged lines
 * map to themselves, so split/join leaves clean content byte-identical.
 */
function redactJsonlContent(content: string): string {
  return content
    .split("\n")
    .map((line) => (line.trim() === "" ? line : redactSerializedJson(line)))
    .join("\n");
}

function redactContent(content: string, ext: string): string {
  if (ext === ".json") return redactSerializedJson(content, 2);
  if (ext === ".jsonl") return redactJsonlContent(content);
  return redactSecrets(content);
}

/**
 * Run a secret-redaction sweep over every staged text file under
 * `stagingDir`, rewriting in place any file where `redactSecrets()` found a
 * match. Unchanged files are left byte-identical (no gratuitous rewrites).
 *
 * Per-file failures *before* anything sweep-worthy is detected (unreadable
 * or unstattable files) are logged and skipped — they leak nothing the
 * sweep would have changed, and a single bad file must never fail the
 * export (degraded mode beats no archive at all). Once a file is known to
 * need rewriting (a secret was detected, or it is oversized), failures fail
 * closed instead: the file's content is replaced with an omission note, and
 * if even that fails the error propagates and the export fails rather than
 * shipping the original content.
 *
 * `filesOmitted` counts files whose content was replaced with an omission
 * note: oversized files (never read, so not counted as scanned) and files
 * whose redacted content could not be written back (scanned, but not
 * counted as redacted — the redaction never landed).
 */
export function redactStagedExportFiles(stagingDir: string): {
  filesScanned: number;
  filesRedacted: number;
  filesOmitted: number;
} {
  let filesScanned = 0;
  let filesRedacted = 0;
  let filesOmitted = 0;

  const stack: string[] = [stagingDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(
        { err, dir },
        "Failed to read staged export directory during secret sweep; skipping",
      );
      continue;
    }
    for (const entry of entries) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      // Dirent type checks use lstat semantics, so symlinks are neither
      // files nor directories here — they are skipped, never followed.
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();

      // Phase 1 — classify and scan. Failures here mean the file's content
      // was never read into the sweep, so skipping it leaks nothing.
      let size = 0;
      let content = "";
      let redacted = "";
      try {
        if (!sniffsAsText(filePath)) continue;
        size = statSync(filePath).size;
        if (size <= MAX_SWEEP_FILE_BYTES) {
          content = readFileSync(filePath, "utf-8");
          filesScanned++;
          redacted = redactContent(content, ext);
        }
      } catch (err) {
        log.warn(
          { err, file: filePath },
          "Failed to sweep staged export file for secrets; continuing",
        );
        continue;
      }

      // Phase 2 — rewrite. From here the file is known to need new content,
      // so failures must not fall through to the tar step with the original
      // bytes. `replaceFileWithNote` throws on failure, failing the export.
      if (size > MAX_SWEEP_FILE_BYTES) {
        // Fail closed: an oversized sweep-eligible file must not ship
        // unswept — it may carry legacy plaintext secrets the sweep exists
        // to catch. Normally unreachable now that every staged section is
        // bounded at the source; retained as the final belt so assumption
        // drift (a future unbounded section) can't silently ship unswept
        // secrets.
        log.warn(
          { file: filePath, size },
          "Staged export file exceeds secret sweep size cap; replacing content with omission note",
        );
        replaceFileWithNote(filePath, OVERSIZED_FILE_NOTE);
        filesOmitted++;
        continue;
      }
      if (redacted === content) continue;
      try {
        // Staged copies inherit source mode bits (`cpSync` preserves them),
        // so a read-only workspace attachment arrives read-only and the
        // rewrite below would throw. Loosening the mode on the export copy
        // is an accepted tradeoff: the staging dir is daemon-private, and a
        // mode-bit change in the tar is far better than a leaked secret.
        // Clean files are never chmod'd, keeping them byte- and
        // mode-identical.
        chmodSync(filePath, 0o600);
        writeFileSync(filePath, redacted, "utf-8");
        filesRedacted++;
      } catch (err) {
        log.warn(
          { err, file: filePath },
          "Failed to write redacted content back to staged export file; replacing content with omission note",
        );
        replaceFileWithNote(filePath, UNWRITABLE_FILE_NOTE);
        filesOmitted++;
      }
    }
  }

  return { filesScanned, filesRedacted, filesOmitted };
}
