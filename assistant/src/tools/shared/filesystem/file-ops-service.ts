import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { sandboxPolicy, type PathResult } from './path-policy.js';
import { checkFileSizeOnDisk, checkContentSize } from './size-guard.js';
import { applyEdit } from './edit-engine.js';
import * as Err from './errors.js';
import type {
  ReadInput,
  ReadResult,
  WriteInput,
  WriteResult,
  EditInput,
  EditResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Path policy hook
// ---------------------------------------------------------------------------

/**
 * Resolves and validates a path against the sandbox boundary.
 * Returns the resolved absolute path or an FsError.
 */
function resolvePath(
  rawPath: string,
  workingDir: string,
  opts?: { mustExist?: boolean },
): { ok: true; resolved: string } | { ok: false; error: Err.FsError } {
  const result: PathResult = sandboxPolicy(rawPath, workingDir, opts);
  if (!result.ok) {
    return { ok: false, error: Err.invalidPath(rawPath, result.error) };
  }
  return { ok: true, resolved: result.resolved };
}

// ---------------------------------------------------------------------------
// readFileSafe
// ---------------------------------------------------------------------------

export function readFileSafe(
  input: ReadInput,
  workingDir: string,
): ReadResult {
  // 1. Path policy
  const pathResult = resolvePath(input.path, workingDir);
  if (!pathResult.ok) return { ok: false, error: pathResult.error };
  const filePath = pathResult.resolved;

  // 2. Existence check
  if (!existsSync(filePath)) {
    return { ok: false, error: Err.notFound(filePath) };
  }

  // 3. Must be a regular file
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return { ok: false, error: Err.notAFile(filePath) };
  }

  // 4. Size guard
  const sizeErr = checkFileSizeOnDisk(filePath);
  if (sizeErr) {
    return { ok: false, error: Err.sizeLimitExceeded(filePath, '', sizeErr) };
  }

  // 5. Read + optional slicing
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const offset = (typeof input.offset === 'number' ? input.offset : 1) - 1;
    const limit = typeof input.limit === 'number' ? input.limit : lines.length;
    const selectedLines = lines.slice(Math.max(0, offset), offset + limit);

    const numbered = selectedLines
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

// ---------------------------------------------------------------------------
// writeFileSafe
// ---------------------------------------------------------------------------

export function writeFileSafe(
  input: WriteInput,
  workingDir: string,
): WriteResult {
  // 1. Path policy (file may not exist yet)
  const pathResult = resolvePath(input.path, workingDir, { mustExist: false });
  if (!pathResult.ok) return { ok: false, error: pathResult.error };
  const filePath = pathResult.resolved;

  // 2. Content size guard
  const sizeErr = checkContentSize(input.content, filePath);
  if (sizeErr) {
    return { ok: false, error: Err.sizeLimitExceeded(filePath, '', sizeErr) };
  }

  // 3. Disk I/O
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
        // unreadable — treat as empty
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

// ---------------------------------------------------------------------------
// editFileSafe
// ---------------------------------------------------------------------------

export function editFileSafe(
  input: EditInput,
  workingDir: string,
): EditResult {
  // 1. Path policy
  const pathResult = resolvePath(input.path, workingDir);
  if (!pathResult.ok) return { ok: false, error: pathResult.error };
  const filePath = pathResult.resolved;

  // 2. Existence + size guard
  if (!existsSync(filePath)) {
    return { ok: false, error: Err.notFound(filePath) };
  }

  const sizeErr = checkFileSizeOnDisk(filePath);
  if (sizeErr) {
    return { ok: false, error: Err.sizeLimitExceeded(filePath, '', sizeErr) };
  }

  // 3. Read + apply edit engine
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = applyEdit(
      content,
      input.oldString,
      input.newString,
      input.replaceAll,
    );

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return { ok: false, error: Err.matchNotFound(filePath) };
      }
      return { ok: false, error: Err.matchAmbiguous(filePath, result.matchCount) };
    }

    // 4. Write updated content
    writeFileSync(filePath, result.updatedContent);

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: Err.ioError(filePath, msg) };
  }
}
