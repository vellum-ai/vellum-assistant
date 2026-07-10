/**
 * The memory plugin's single host-path channel. Every module in this plugin
 * resolves filesystem locations here rather than importing host
 * `util/platform` directly, so the host import below is the plugin's sole
 * path escape (tracked by `plugin-import-boundary-guard.test.ts`), mirroring
 * `logging.ts`.
 *
 * A plain forward is deliberate: `@vellumai/plugin-api` has no workspace-dir
 * facet today (identity facets take the workspace dir as a parameter), and
 * these resolvers also run inside the jobs worker and CLI processes where no
 * plugin bootstrap exists. Centralizing the import keeps a future cutover —
 * a paths facet on the contract, or `InitContext`-provided roots — a
 * one-file change. `getMemoryWorkerPidPath` is the PID-file coordination
 * point shared with the host spawn/status paths (`persistence/worker-control`,
 * `runtime/routes/memory-worker-routes`), so it must stay host-defined.
 */
// A namespace import (not named imports) so tests that mock `util/platform`
// with a subset of its exports don't fail this module's import link — each
// forward resolves its function at call time.
import * as hostPlatform from "../../../util/platform.js";

export function getWorkspaceDir(): string {
  return hostPlatform.getWorkspaceDir();
}

export function getWorkspacePromptPath(file: string): string {
  return hostPlatform.getWorkspacePromptPath(file);
}

export function getWorkspaceConfigPath(): string {
  return hostPlatform.getWorkspaceConfigPath();
}

export function getDataDir(): string {
  return hostPlatform.getDataDir();
}

export function getSandboxWorkingDir(): string {
  return hostPlatform.getSandboxWorkingDir();
}

export function getEmbeddingModelsDir(): string {
  return hostPlatform.getEmbeddingModelsDir();
}

export function getMemoryWorkerPidPath(): string {
  return hostPlatform.getMemoryWorkerPidPath();
}
