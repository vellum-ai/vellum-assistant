import { sandboxPolicy } from '../shared/filesystem/path-policy.js';

/**
 * Compatibility shim — forwards to the shared sandbox path policy.
 *
 * All new code should import `sandboxPolicy` or `hostPolicy` from
 * `tools/shared/filesystem/path-policy.js` directly.
 */
export function validateFilePath(
  rawPath: string,
  workingDir: string,
  options?: { mustExist?: boolean },
): { ok: true; resolved: string } | { ok: false; error: string } {
  const result = sandboxPolicy(rawPath, workingDir, options);
  if (result.ok) {
    return result;
  }
  return { ok: false, error: result.error.message };
}
