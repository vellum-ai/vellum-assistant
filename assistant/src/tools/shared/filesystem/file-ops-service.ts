import {
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { minimatch } from "minimatch";

import { ensureDir, pathExists } from "../../../util/fs.js";
import { applyEdit } from "./edit-engine.js";
import * as Err from "./errors.js";
import type { PathFailureReason, PathResult } from "./path-policy.js";
import { checkContentSize, checkFileSizeOnDisk } from "./size-guard.js";
import type {
  EditInput,
  EditResult,
  ListInput,
  ListResult,
  ReadInput,
  ReadResult,
  WriteInput,
  WriteResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Path policy hook
// ---------------------------------------------------------------------------

/**
 * A function that validates a raw path and returns a resolved absolute path
 * or an error string. Both sandbox and host policies satisfy this shape.
 */
export type PathPolicy = (
  rawPath: string,
  options?: { mustExist?: boolean },
) => PathResult;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function pathError(
  path: string,
  reason: PathFailureReason,
  detail: string,
): Err.FsError {
  switch (reason) {
    case "not_absolute":
      return Err.pathNotAbsolute(path);
    case "out_of_bounds":
      return { code: "PATH_OUT_OF_BOUNDS", message: detail, path };
  }
}

export class FileSystemOps {
  private policy: PathPolicy;
  private sizeLimit: number | undefined;

  constructor(policy: PathPolicy, options?: { sizeLimit?: number }) {
    this.policy = policy;
    this.sizeLimit = options?.sizeLimit;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  readFileSafe(input: ReadInput): ReadResult {
    const pathCheck = this.policy(input.path, { mustExist: true });
    if (!pathCheck.ok) {
      return {
        ok: false,
        error: pathError(input.path, pathCheck.reason, pathCheck.error),
      };
    }
    const filePath = pathCheck.resolved;

    if (!pathExists(filePath)) {
      return { ok: false, error: Err.notFound(filePath) };
    }

    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, error: Err.notAFile(filePath) };
    }

    const sizeErr = checkFileSizeOnDisk(filePath, this.sizeLimit);
    if (sizeErr) {
      return { ok: false, error: Err.sizeLimitExceeded(filePath, sizeErr) };
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n");

      const offset = (input.offset ?? 1) - 1;
      const limit = input.limit ?? lines.length;
      const selected = lines.slice(Math.max(0, offset), offset + limit);

      const numbered = selected
        .map((line, i) => {
          const lineNum = offset + i + 1;
          return `${String(lineNum).padStart(6)}  ${line}`;
        })
        .join("\n");

      return { ok: true, value: { content: numbered } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: Err.ioError(filePath, msg) };
    }
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  writeFileSafe(input: WriteInput): WriteResult {
    const pathCheck = this.policy(input.path, { mustExist: false });
    if (!pathCheck.ok) {
      return {
        ok: false,
        error: pathError(input.path, pathCheck.reason, pathCheck.error),
      };
    }
    const filePath = pathCheck.resolved;

    const sizeErr = checkContentSize(input.content, filePath, this.sizeLimit);
    if (sizeErr) {
      return { ok: false, error: Err.sizeLimitExceeded(filePath, sizeErr) };
    }

    try {
      ensureDir(dirname(filePath));

      let oldContent = "";
      const isNewFile = !pathExists(filePath);
      if (!isNewFile) {
        try {
          oldContent = readFileSync(filePath, "utf-8");
        } catch {
          // Unreadable existing file - keep oldContent as empty string.
        }
      }

      writeFileSync(filePath, input.content);

      return {
        ok: true,
        value: {
          filePath,
          isNewFile,
          oldContent,
          newContent: input.content,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: Err.ioError(filePath, msg) };
    }
  }

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------

  editFileSafe(input: EditInput): EditResult {
    const pathCheck = this.policy(input.path, { mustExist: true });
    if (!pathCheck.ok) {
      return {
        ok: false,
        error: pathError(input.path, pathCheck.reason, pathCheck.error),
      };
    }
    const filePath = pathCheck.resolved;

    // Size-check the file on disk (swallow ENOENT - readFileSync gives a clearer error)
    try {
      const sizeErr = checkFileSizeOnDisk(filePath, this.sizeLimit);
      if (sizeErr) {
        return { ok: false, error: Err.sizeLimitExceeded(filePath, sizeErr) };
      }
    } catch {
      // Fall through - the readFileSync below will surface NOT_FOUND.
    }

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      const code =
        err instanceof Error && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "EISDIR") {
        return { ok: false, error: Err.notAFile(filePath) };
      }
      if (code === "ENOENT") {
        return { ok: false, error: Err.notFound(filePath) };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: Err.ioError(filePath, msg) };
    }

    if (input.oldString.length === 0) {
      return { ok: false, error: Err.matchNotFound(filePath) };
    }

    const result = applyEdit(
      content,
      input.oldString,
      input.newString,
      input.replaceAll,
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return { ok: false, error: Err.matchNotFound(filePath) };
      }
      return {
        ok: false,
        error: Err.matchAmbiguous(filePath, result.matchCount),
      };
    }

    try {
      writeFileSync(filePath, result.updatedContent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: Err.ioError(filePath, msg) };
    }

    return {
      ok: true,
      value: {
        filePath,
        matchCount: result.matchCount,
        oldContent: content,
        newContent: result.updatedContent,
        matchMethod: result.matchMethod,
        similarity: result.similarity,
        actualOld: result.actualOld,
        actualNew: result.actualNew,
      },
    };
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  listDirSafe(input: ListInput): ListResult {
    const pathCheck = this.policy(input.path, { mustExist: true });
    if (!pathCheck.ok) {
      return {
        ok: false,
        error: pathError(input.path, pathCheck.reason, pathCheck.error),
      };
    }
    const resolved = pathCheck.resolved;

    if (!pathExists(resolved)) {
      return { ok: false, error: Err.notFound(resolved) };
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: Err.notADirectory(resolved) };
    }

    try {
      let entries = readdirSync(resolved, { withFileTypes: true });

      if (input.glob) {
        const pattern = input.glob;
        entries = entries.filter((e) => minimatch(e.name, pattern));
      }

      // Sort: directories first (alphabetical), then files (alphabetical)
      const dirs = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = entries
        .filter((e) => !e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      const sorted = [...dirs, ...files];

      const MAX_ENTRIES = 500;
      const truncated = sorted.length > MAX_ENTRIES;
      const visible = sorted.slice(0, MAX_ENTRIES);

      const lines = visible.map((entry) => {
        if (entry.isDirectory()) {
          return `${entry.name}/`;
        }
        if (entry.isSymbolicLink()) {
          return `${entry.name}@`;
        }
        const fileStat = lstatSync(join(resolved, entry.name));
        return `${entry.name}  ${formatSize(fileStat.size)}`;
      });

      if (truncated) {
        lines.push(
          `\n... and ${sorted.length - MAX_ENTRIES} more entries (use glob to filter)`,
        );
      }

      return { ok: true, value: { listing: lines.join("\n") } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: Err.ioError(resolved, msg) };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
