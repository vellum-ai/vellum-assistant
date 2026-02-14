import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PathResult } from './path-policy.js';
import { checkFileSizeOnDisk, checkContentSize } from './size-guard.js';
import { applyEdit } from './edit-engine.js';
import type {
  ReadInput, ReadResult,
  WriteInput, WriteResult,
  EditInput, EditResult,
} from './types.js';
import * as Err from './errors.js';

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

export class FileSystemOps {
  private policy: PathPolicy;

  constructor(policy: PathPolicy) {
    this.policy = policy;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  readFileSafe(input: ReadInput): ReadResult {
    const pathCheck = this.policy(input.path, { mustExist: true });
    if (!pathCheck.ok) {
      return { ok: false, error: Err.invalidPath(input.path, pathCheck.error) };
    }
    const filePath = pathCheck.resolved;

    if (!existsSync(filePath)) {
      return { ok: false, error: Err.notFound(filePath) };
    }

    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, error: Err.notAFile(filePath) };
    }

    const sizeErr = checkFileSizeOnDisk(filePath);
    if (sizeErr) {
      return { ok: false, error: Err.sizeLimitExceeded(filePath, `${stat.size}`, sizeErr) };
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n');

      const offset = (input.offset ?? 1) - 1;
      const limit = input.limit ?? lines.length;
      const selected = lines.slice(Math.max(0, offset), offset + limit);

      const numbered = selected
        .map((line, i) => {
          const lineNum = offset + i + 1;
          return `${String(lineNum).padStart(6)}  ${line}`;
        })
        .join('\n');

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
      return { ok: false, error: Err.invalidPath(input.path, pathCheck.error) };
    }
    const filePath = pathCheck.resolved;

    const sizeErr = checkContentSize(input.content, filePath);
    if (sizeErr) {
      return { ok: false, error: Err.sizeLimitExceeded(filePath, 'content', sizeErr) };
    }

    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      let oldContent = '';
      const isNewFile = !existsSync(filePath);
      if (!isNewFile) {
        try {
          oldContent = readFileSync(filePath, 'utf-8');
        } catch {
          // Unreadable existing file — keep oldContent as empty string.
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
      return { ok: false, error: Err.invalidPath(input.path, pathCheck.error) };
    }
    const filePath = pathCheck.resolved;

    // Size-check the file on disk (swallow ENOENT — readFileSync gives a clearer error)
    try {
      const sizeErr = checkFileSizeOnDisk(filePath);
      if (sizeErr) {
        return { ok: false, error: Err.sizeLimitExceeded(filePath, 'file', sizeErr) };
      }
    } catch {
      // Fall through — the readFileSync below will surface NOT_FOUND.
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return { ok: false, error: Err.notFound(filePath) };
    }

    const result = applyEdit(content, input.oldString, input.newString, input.replaceAll);

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return { ok: false, error: Err.matchNotFound(filePath) };
      }
      return { ok: false, error: Err.matchAmbiguous(filePath, result.matchCount) };
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
      },
    };
  }
}
