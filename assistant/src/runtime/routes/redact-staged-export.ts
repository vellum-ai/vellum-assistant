/**
 * Export-time secret sweep for the log export staging directory.
 *
 * `POST /v1/export` stages audit DB rows, daemon logs, a sanitized config
 * snapshot, and allowlisted workspace files before archiving them. The
 * structural sanitizers (write-time audit-input redaction, config snapshot
 * env scrubbing) only protect data written after they shipped — legacy audit
 * rows already persisted with plaintext inputs, and free-form workspace
 * conversation logs, can still carry raw secrets. This module is the final
 * belt: a pattern-based `redactSecrets()` pass over every staged text file
 * immediately before the tar.gz is created.
 */

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("redact-staged-export");

/**
 * Extensions eligible for the sweep. Covers everything the export stages as
 * text today: `audit-data.json`, `messages.json`, `config-snapshot.json`,
 * daemon `.log` files, `conversation-filtered.jsonl`, and the workspace
 * copies (`conversations/**\/messages.jsonl`, `.tool-results/*.txt`).
 */
const REDACTABLE_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".txt",
  ".log",
  ".md",
]);

/**
 * Files larger than this are skipped to bound memory — the sweep reads each
 * file fully into memory. Today's largest staged file is ~1–3 MB, so 32 MiB
 * leaves ample headroom.
 */
const MAX_SWEEP_FILE_BYTES = 32 * 1024 * 1024;

interface RedactionState {
  changed: boolean;
}

function redactString(value: string, state: RedactionState): string {
  const redacted = redactSecrets(value);
  if (redacted !== value) state.changed = true;
  return redacted;
}

/**
 * Redact secrets in a parsed JSON value, walking every string leaf (keys
 * included). Sets `state.changed` when any redaction fired.
 */
function redactJsonValue(value: unknown, state: RedactionState): unknown {
  if (typeof value === "string") {
    return redactString(value, state);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, state));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, val]) =>
          [redactString(key, state), redactJsonValue(val, state)] as const,
      ),
    );
  }
  return value;
}

/**
 * Redact a `.json` file's content while preserving JSON validity. The
 * redaction marker (`<redacted type="..." />`) contains double quotes, so
 * splicing it into serialized JSON would corrupt any string it lands inside.
 * Parse, redact every string leaf, and re-stringify instead. Falls back to
 * plain-text redaction when the content isn't valid JSON — the file is
 * already malformed, so there is no validity to preserve.
 */
function redactJsonContent(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return redactSecrets(content);
  }
  const state = { changed: false };
  const redacted = redactJsonValue(parsed, state);
  return state.changed ? JSON.stringify(redacted, null, 2) : content;
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
      if (!REDACTABLE_EXTENSIONS.has(ext)) continue;

      try {
        const { size } = statSync(filePath);
        if (size > MAX_SWEEP_FILE_BYTES) {
          log.warn(
            { file: filePath, size },
            "Staged export file exceeds secret sweep size cap; skipping",
          );
          continue;
        }
        const content = readFileSync(filePath, "utf-8");
        filesScanned++;
        const redacted =
          ext === ".json"
            ? redactJsonContent(content)
            : redactSecrets(content);
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
