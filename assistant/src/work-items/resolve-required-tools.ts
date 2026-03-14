import { sanitizeToolList } from "../tasks/tool-sanitizer.js";

/**
 * Resolve the effective required tools for a work item, falling back to
 * task-level tools when the snapshot is null or sanitizes to empty.
 *
 * This prevents an explicitly empty `required_tools: []` snapshot from
 * suppressing the task's actual tool requirements — closing a permission
 * bypass where preflight/run would skip authorization while runTask still
 * builds ephemeral allow rules from the task template's requiredTools.
 */
export function resolveRequiredTools(
  snapshotRequiredTools: string | null,
  taskRequiredTools: string[],
): string[] {
  if (snapshotRequiredTools == null) {
    return taskRequiredTools;
  }

  const snapshotTools = sanitizeToolList(JSON.parse(snapshotRequiredTools));
  if (snapshotTools.length > 0) {
    return snapshotTools;
  }

  return taskRequiredTools;
}
