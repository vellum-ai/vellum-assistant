import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
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

// Serialize mutations per resolved path. The agent loop executes sibling
// tool calls in parallel, and the async read -> apply -> write window would
// otherwise let two edits of the same file both read the same old content and
// have the later write silently drop the earlier edit (the previous
// synchronous service made each mutation atomic within the event loop).
const fileWriteLocks = new Map<string, Promise<void>>();

async function withFileWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileWriteLocks.get(filePath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileWriteLocks.set(filePath, tail);
  void tail.then(() => {
    if (fileWriteLocks.get(filePath) === tail) {
      fileWriteLocks.delete(filePath);
    }
  });
  return run;
}

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
    case "denied":
      return { code: "PATH_OUT_OF_BOUNDS", message: detail, path };
  }
}

/**
 * Characters returned by a read that names no `max_chars`. Stays under
 * `THRESHOLD_CHARS` in `context/post-turn-tool-result-truncation.ts`, which
 * spools any larger tool result to disk and replaces it inline with a short
 * stub, so a default read returns content rather than a stub.
 */
export const READ_CHAR_BUDGET = 20_000;

/**
 * Trailing marker appended when a read stops short of the end of the file. A
 * model that cannot tell a window from a whole file reasons about code it
 * never saw.
 */
function truncationNotice(
  start: number,
  end: number,
  totalChars: number,
): string {
  return `\n\n[Truncated: characters ${start}-${end} of ${totalChars}. Read on with start_index=${end}.]`;
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/**
 * Character window that never splits a surrogate pair. A split leaves a lone
 * half at each edge, and each encodes to U+FFFD, so the character is lost from
 * both this window and the next one paged in after it.
 */
export function surrogateSafeWindow(
  total: number,
  charCodeAt: (index: number) => number,
  requestedStart: number,
  maxChars: number,
): { start: number; end: number } {
  let start = Math.max(0, Math.min(requestedStart, total));
  if (start > 0 && start < total && isLowSurrogate(charCodeAt(start))) {
    start -= 1;
  }

  let end = Math.min(total, start + maxChars);
  if (end > start && end < total && isHighSurrogate(charCodeAt(end - 1))) {
    // Backing off would empty a one-character window, which stalls paging on
    // the same offset, so take the whole pair instead.
    end = end - 1 > start ? end - 1 : Math.min(total, end + 1);
  }

  return { start, end };
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

  async readFileSafe(input: ReadInput): Promise<ReadResult> {
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

    const pathStat = await stat(filePath);
    if (!pathStat.isFile()) {
      return { ok: false, error: Err.notAFile(filePath) };
    }

    const sizeErr = await checkFileSizeOnDisk(filePath, this.sizeLimit);
    if (sizeErr) {
      return { ok: false, error: Err.sizeLimitExceeded(filePath, sizeErr) };
    }

    try {
      const raw = await readFile(filePath, "utf-8");

      // A ceiling, not just a default: a larger window would be spooled to
      // disk and replaced with a stub, returning less than this.
      const maxChars = Math.min(
        READ_CHAR_BUDGET,
        Math.max(0, input.maxChars ?? READ_CHAR_BUDGET),
      );
      const { start, end } = surrogateSafeWindow(
        raw.length,
        (i) => raw.charCodeAt(i),
        input.startIndex ?? 0,
        maxChars,
      );
      const window = raw.slice(start, end);

      // An empty window means the caller paged past the end or asked for
      // nothing, which is not a truncated read.
      const content =
        window.length > 0 && end < raw.length
          ? window + truncationNotice(start, end, raw.length)
          : window;

      return { ok: true, value: { content } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: Err.ioError(filePath, msg) };
    }
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  async writeFileSafe(input: WriteInput): Promise<WriteResult> {
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

    return withFileWriteLock(filePath, async (): Promise<WriteResult> => {
      try {
        ensureDir(dirname(filePath));

        let oldContent = "";
        const isNewFile = !pathExists(filePath);
        if (!isNewFile) {
          try {
            oldContent = await readFile(filePath, "utf-8");
          } catch {
            // Unreadable existing file - keep oldContent as empty string.
          }
        }

        await writeFile(filePath, input.content);

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
    });
  }

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------

  async editFileSafe(input: EditInput): Promise<EditResult> {
    const pathCheck = this.policy(input.path, { mustExist: true });
    if (!pathCheck.ok) {
      return {
        ok: false,
        error: pathError(input.path, pathCheck.reason, pathCheck.error),
      };
    }
    const filePath = pathCheck.resolved;

    return withFileWriteLock(filePath, async (): Promise<EditResult> => {
      // Size-check the file on disk (swallow ENOENT - the read below gives a
      // clearer error)
      try {
        const sizeErr = await checkFileSizeOnDisk(filePath, this.sizeLimit);
        if (sizeErr) {
          return { ok: false, error: Err.sizeLimitExceeded(filePath, sizeErr) };
        }
      } catch {
        // Fall through - the read below will surface NOT_FOUND.
      }

      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
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
        await writeFile(filePath, result.updatedContent);
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
    });
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  async listDirSafe(input: ListInput): Promise<ListResult> {
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

    const pathStat = await stat(resolved);
    if (!pathStat.isDirectory()) {
      return { ok: false, error: Err.notADirectory(resolved) };
    }

    try {
      let entries = await readdir(resolved, { withFileTypes: true });

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

      const lines = await Promise.all(
        visible.map(async (entry) => {
          if (entry.isDirectory()) {
            return `${entry.name}/`;
          }
          if (entry.isSymbolicLink()) {
            return `${entry.name}@`;
          }
          const fileStat = await lstat(join(resolved, entry.name));
          return `${entry.name}  ${formatSize(fileStat.size)}`;
        }),
      );

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
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
