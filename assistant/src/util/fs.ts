/**
 * Centralized filesystem helpers — single source of truth for common
 * existence-check and stat patterns scattered across the codebase.
 *
 * Modules should import from here instead of using raw existsSync/statSync
 * from 'node:fs' for these patterns.
 */

import { existsSync, mkdirSync, readFileSync, statSync, type Stats } from 'node:fs';

/** Check whether a path (file or directory) exists on disk. */
export function pathExists(path: string): boolean {
  return existsSync(path);
}

/** Create a directory (and parents) if it doesn't already exist. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Read a UTF-8 text file, returning null if it doesn't exist or is unreadable. */
export function readTextFileSync(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Get file stats, returning null if the path doesn't exist or is inaccessible. */
export function safeStatSync(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
