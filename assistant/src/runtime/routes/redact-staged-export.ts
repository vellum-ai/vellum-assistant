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
 * Coverage: every staged file with an allowlisted text extension
 * (`REDACTABLE_EXTENSIONS`), plus any other staged file that sniffs as text
 * (no NUL byte in its first 8 KiB) — e.g. conversation `attachments/` with
 * arbitrary user extensions (`.env`, `.csv`, extensionless). Files that
 * sniff as binary are left untouched. Serialized-JSON formats (`.json`,
 * `.jsonl`) are redacted via a parse → redact-string-leaves → re-stringify
 * path so the quoted redaction marker cannot corrupt them. Files above the
 * size cap are NOT shipped unswept: their content is replaced with a short
 * omission note (fail closed).
 */

import type { Dirent } from "node:fs";
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import { redactJsonStringLeaves } from "../../security/redact-json.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("redact-staged-export");

/**
 * Extensions always eligible for the sweep, no sniffing needed. Covers
 * everything the export stages as text today: `audit-data.json`,
 * `messages.json`, `config-snapshot.json`, daemon `.log` files,
 * `conversation-filtered.jsonl`, and the workspace copies
 * (`conversations/**\/messages.jsonl`, `.tool-results/*.txt`). Files with
 * other extensions are still swept when they sniff as text (see module doc).
 */
const REDACTABLE_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".txt",
  ".log",
  ".md",
]);

/**
 * Files larger than this are not read into memory — the sweep reads each
 * file fully to redact it. Today's largest staged file is ~1–3 MB, so 32 MiB
 * leaves ample headroom. Oversized sweep-eligible files fail closed: their
 * content is replaced with `OVERSIZED_FILE_NOTE` so legacy plaintext secrets
 * can never ship unswept (e.g. an unbounded `messages.json` on `full: true`
 * exports).
 */
export const MAX_SWEEP_FILE_BYTES = 32 * 1024 * 1024;

/** Replacement content for files that exceed `MAX_SWEEP_FILE_BYTES`. */
export const OVERSIZED_FILE_NOTE = `[content omitted from export: file exceeded the ${
  MAX_SWEEP_FILE_BYTES / (1024 * 1024)
} MiB secret-redaction cap]\n`;

/**
 * Bytes read from the head of a non-allowlisted-extension file to classify
 * it as text (sweep it) or binary (leave it untouched).
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
 * redact every string leaf, and re-stringify (unchanged text is returned
 * byte-identical). Falls back to plain-text redaction when the text isn't
 * valid JSON — it is already malformed, so there is no validity to preserve.
 */
function redactSerializedJson(
  text: string,
  stringify: (value: unknown) => string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactSecrets(text);
  }
  const { value, changed } = redactJsonStringLeaves(parsed);
  return changed ? stringify(value) : text;
}

/**
 * Redact a `.jsonl` file's content line by line, preserving each line's
 * JSON validity (compact re-stringify, no pretty-printing).
 */
function redactJsonlContent(content: string): string {
  let changed = false;
  const lines = content.split("\n").map((line) => {
    if (line.trim() === "") return line;
    const redacted = redactSerializedJson(line, (value) =>
      JSON.stringify(value),
    );
    if (redacted !== line) changed = true;
    return redacted;
  });
  return changed ? lines.join("\n") : content;
}

function redactContent(content: string, ext: string): string {
  if (ext === ".json") {
    return redactSerializedJson(content, (value) =>
      JSON.stringify(value, null, 2),
    );
  }
  if (ext === ".jsonl") return redactJsonlContent(content);
  return redactSecrets(content);
}

/**
 * Run a secret-redaction sweep over every staged text file under
 * `stagingDir`, rewriting in place any file where `redactSecrets()` found a
 * match. Unchanged files are left byte-identical (no gratuitous rewrites).
 *
 * Per-file failures are logged and skipped — a single unreadable file must
 * never fail the export (degraded mode beats no archive at all).
 */
export function redactStagedExportFiles(stagingDir: string): {
  filesScanned: number;
  filesRedacted: number;
} {
  let filesScanned = 0;
  let filesRedacted = 0;

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

      try {
        // Files outside the extension allowlist (e.g. staged conversation
        // attachments) are still swept when they sniff as text; only
        // binary-looking files are exempt.
        if (!REDACTABLE_EXTENSIONS.has(ext) && !sniffsAsText(filePath)) {
          continue;
        }
        const { size } = statSync(filePath);
        if (size > MAX_SWEEP_FILE_BYTES) {
          // Fail closed: an oversized sweep-eligible file must not ship
          // unswept — it may carry legacy plaintext secrets the sweep
          // exists to catch. Replace its content with a short note.
          log.warn(
            { file: filePath, size },
            "Staged export file exceeds secret sweep size cap; replacing content with omission note",
          );
          writeFileSync(filePath, OVERSIZED_FILE_NOTE, "utf-8");
          filesScanned++;
          filesRedacted++;
          continue;
        }
        const content = readFileSync(filePath, "utf-8");
        filesScanned++;
        const redacted = redactContent(content, ext);
        if (redacted !== content) {
          writeFileSync(filePath, redacted, "utf-8");
          filesRedacted++;
        }
      } catch (err) {
        log.warn(
          { err, file: filePath },
          "Failed to sweep staged export file for secrets; continuing",
        );
      }
    }
  }

  return { filesScanned, filesRedacted };
}
