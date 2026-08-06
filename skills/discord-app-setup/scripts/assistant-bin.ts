/**
 * Resolve the `assistant` CLI executable.
 *
 * Skill scripts run as child processes of the daemon and inherit its PATH.
 * That PATH does not always contain the directory the CLI was installed into
 * (sandbox contexts are the usual case), and a bare `Bun.spawn(["assistant"])`
 * then fails with ENOENT before the script has done anything.
 *
 * The daemon always exports `VELLUM_WORKSPACE_DIR`, and a local install writes
 * a wrapper at `<workspace>/bin/assistant`, so that path is a reliable
 * fallback when PATH lookup comes up empty.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Absolute path to the `assistant` executable, or the bare name when neither
 * lookup succeeds so the spawn failure still names the command the caller
 * meant to run.
 */
export function resolveAssistantBin(): string {
  const onPath = Bun.which("assistant");
  if (onPath) {
    return onPath;
  }

  const workspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  if (workspaceDir) {
    const wrapper = join(workspaceDir, "bin", "assistant");
    if (existsSync(wrapper)) {
      return wrapper;
    }
  }

  return "assistant";
}
