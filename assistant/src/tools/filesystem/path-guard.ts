import { sandboxPathPolicy, type PathPolicyResult } from '../shared/filesystem/path-policy.js';

/**
 * Compatibility shim — forwards to the shared sandbox path policy.
 *
 * Existing callers continue to work without changes. New code should
 * import directly from `tools/shared/filesystem/path-policy.js`.
 */
export function validateFilePath(
  rawPath: string,
  workingDir: string,
  options?: { mustExist?: boolean },
): PathPolicyResult {
  return sandboxPathPolicy(rawPath, workingDir, options);
}
