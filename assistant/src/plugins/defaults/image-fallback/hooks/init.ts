/**
 * `init` hook: stashes the workspace attachments directory so the
 * `user-prompt-submit` hook can persist image files for text-only models.
 *
 * The attachments dir is derived from `pluginStorageDir` (two levels up to
 * reach the workspace root, then `attachments/`). Created on init if it
 * doesn't exist.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PluginHookFn, PluginInitContext } from "@vellumai/plugin-api";

let attachmentsDir: string | null = null;

const init: PluginHookFn<PluginInitContext> = async (ctx) => {
  // pluginStorageDir is `<workspaceDir>/plugins-data/<plugin>/`.
  // Derive the workspace root and create an attachments subdir.
  const workspaceRoot = dirname(dirname(ctx.pluginStorageDir));
  attachmentsDir = join(workspaceRoot, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });
};

/** Resolved attachments directory, or null if init hasn't run yet. */
export function getAttachmentsDir(): string | null {
  return attachmentsDir;
}

export default init;
