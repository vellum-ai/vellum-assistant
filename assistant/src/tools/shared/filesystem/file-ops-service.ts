import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PathResult } from './path-policy.js';
import { checkFileSizeOnDisk, checkContentSize } from './size-guard.js';
import { applyEdit } from './edit-engine.js';
import * as Errors from './errors.js';
import type { FsError } from './errors.js';
import type {
  ReadInput, ReadResult,
  WriteInput, WriteResult,
  EditInput, EditResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Path policy — injected by caller so the service works for both
// sandbox (boundary-checked) and host (absolute-only) modes.
// ---------------------------------------------------------------------------

export interface PathPolicyOptions {
  mustExist?: boolean;
}

export type PathPolicyFn = (rawPath: string, options?: PathPolicyOptions) => PathResult;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FileSystemOps {
  private readonly policy: PathPolicyFn;

  constructor(policy: PathPolicyFn) {
    this.policy = policy;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  readFile(input: ReadInput): ReadResult {
    const resolved = this.resolvePath(input.path);
    if (!resolved.ok) return resolved;
    const filePath = resolved.value;

    const existence = this.requireFile(filePath);
    if (!existence.ok) return existence;

    const sizeCheck = this.checkDiskSize(filePath);
    if (!sizeCheck.ok) return sizeCheck;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n');

      const offset = (input.offset ?? 1) - 1;
      const limit = input.limit ?? lines.length;
      const selected = lines.slice(Math.max(0, offset), offset + limit);

      const content = selected
        .map((line, i) => `${String(offset + i + 1).padStart(6)}  ${line}`)
        .join('\n');

      return { ok: true, value: { content } };
    } catch (err) {
      return { ok: false, error: Errors.ioError(filePath, errorMessage(err)) };
    }
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  writeFile(input: WriteInput): WriteResult {
    const resolved = this.resolvePath(input.path, { mustExist: false });
    if (!resolved.ok) return resolved;
    const filePath = resolved.value;

    const sizeCheck = this.checkContentSize(input.content, filePath);
    if (!sizeCheck.ok) return sizeCheck;

    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      let oldContent = '';
      const isNewFile = !existsSync(filePath);
      if (!isNewFile) {
        try { oldContent = readFileSync(filePath, 'utf-8'); } catch { /* unreadable */ }
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
      return { ok: false, error: Errors.ioError(filePath, errorMessage(err)) };
    }
  }

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------

  editFile(input: EditInput): EditResult {
    const resolved = this.resolvePath(input.path);
    if (!resolved.ok) return resolved;
    const filePath = resolved.value;

    const existence = this.requireFile(filePath);
    if (!existence.ok) return existence;

    // Size check is best-effort: if stat fails the read below gives a clearer error
    const sizeCheck = this.checkDiskSize(filePath);
    if (!sizeCheck.ok) return sizeCheck;

    try {
      const oldContent = readFileSync(filePath, 'utf-8');
      const result = applyEdit(oldContent, input.oldString, input.newString, input.replaceAll);

      if (!result.ok) {
        if (result.reason === 'not_found') {
          return { ok: false, error: Errors.matchNotFound(filePath) };
        }
        return { ok: false, error: Errors.matchAmbiguous(filePath, result.matchCount) };
      }

      writeFileSync(filePath, result.updatedContent);

      return {
        ok: true,
        value: {
          filePath,
          matchCount: result.matchCount,
          oldContent,
          newContent: result.updatedContent,
          matchMethod: result.matchMethod,
        },
      };
    } catch (err) {
      return { ok: false, error: Errors.ioError(filePath, errorMessage(err)) };
    }
  }

  // -------------------------------------------------------------------------
  // Shared validation helpers
  // -------------------------------------------------------------------------

  private resolvePath(
    rawPath: string,
    options?: PathPolicyOptions,
  ): { ok: true; value: string } | { ok: false; error: FsError } {
    const result = this.policy(rawPath, options);
    if (!result.ok) {
      return { ok: false, error: Errors.invalidPath(rawPath, result.error) };
    }
    return { ok: true, value: result.resolved };
  }

  private requireFile(filePath: string): { ok: true } | { ok: false; error: FsError } {
    if (!existsSync(filePath)) {
      return { ok: false, error: Errors.notFound(filePath) };
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, error: Errors.notAFile(filePath) };
    }
    return { ok: true };
  }

  private checkDiskSize(filePath: string): { ok: true } | { ok: false; error: FsError } {
    const err = checkFileSizeOnDisk(filePath);
    if (err) {
      return { ok: false, error: Errors.sizeLimitExceeded(filePath, 'on-disk', 'configured') };
    }
    return { ok: true };
  }

  private checkContentSize(content: string, filePath: string): { ok: true } | { ok: false; error: FsError } {
    const err = checkContentSize(content, filePath);
    if (err) {
      return { ok: false, error: Errors.sizeLimitExceeded(filePath, 'content', 'configured') };
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
