import { sandboxPolicy, type PathResult } from '../shared/filesystem/path-policy.js';

/**
 * Compatibility shim — forwards to the shared sandbox policy.
 *
 * All existing callers import this function; the actual implementation
 * now lives in `shared/filesystem/path-policy.ts`.
 */
export function validateFilePath(
  rawPath: string,
  workingDir: string,
  options?: { mustExist?: boolean },
): PathResult {
  return sandboxPolicy(rawPath, workingDir, options);
}
