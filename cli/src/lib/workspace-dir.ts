/**
 * Workspace-directory resolver for the `vellum` CLI.
 *
 * Mirrors the daemon-side resolution in `assistant/src/util/platform.ts`:
 * the `VELLUM_WORKSPACE_DIR` environment variable wins when set; otherwise
 * we fall back to `~/.vellum/workspace`. The CLI-side helper exists so
 * commands that touch on-disk workspace state (e.g. plugins install) can
 * resolve a path without spinning up daemon code paths.
 *
 * Note: when the active assistant is a hatched docker container, the
 * host-visible workspace directory may differ from what the in-container
 * daemon sees. Commands that bridge those worlds must surface a path
 * override (e.g. a `--workspace` flag) or coordinate with the assistant
 * entry's `resources.instanceDir`. This helper covers the local-host case.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns the workspace root directory for the current host.
 *
 * Resolution order:
 *   1. `VELLUM_WORKSPACE_DIR` environment variable (trimmed; empty → ignored)
 *   2. `~/.vellum/workspace`
 */
export function resolveWorkspaceDir(): string {
  const override = process.env.VELLUM_WORKSPACE_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".vellum", "workspace");
}

/**
 * Returns `<workspaceDir>/plugins` — the directory the daemon's user plugin
 * loader scans at startup. Mirrors `getWorkspacePluginsDir()` in
 * `assistant/src/util/platform.ts`.
 */
export function resolveWorkspacePluginsDir(): string {
  return join(resolveWorkspaceDir(), "plugins");
}
