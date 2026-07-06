/**
 * Declarative tool manifest - single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { getConfig } from "../config/loader.js";
import {
  isCesSecureInstallEnabled,
  isCesToolsEnabled,
} from "../credential-execution/feature-gates.js";
import { recallTool, rememberTool } from "../plugins/defaults/memory/tools.js";
import { askQuestionTool } from "./ask-question/ask-question-tool.js";
import { makeAuthenticatedRequestTool } from "./credential-execution/make-authenticated-request.js";
import { manageSecureCommandTool } from "./credential-execution/manage-secure-command-tool.js";
import { runAuthenticatedCommandTool } from "./credential-execution/run-authenticated-command.js";
import { fileEditTool } from "./filesystem/edit.js";
import { fileListTool } from "./filesystem/list.js";
import { fileReadTool } from "./filesystem/read.js";
import { codeSearchTool } from "./filesystem/search.js";
import { fileWriteTool } from "./filesystem/write.js";
import { webFetchTool } from "./network/web-fetch.js";
import { webSearchTool } from "./network/web-search.js";
import { skillExecuteTool } from "./skills/execute.js";
import { skillLoadTool } from "./skills/load.js";
import { notifyParentTool } from "./subagent/notify-parent.js";
import { requestSystemPermissionTool } from "./system/request-permission.js";
import { shellTool } from "./terminal/shell.js";
import type { ToolDefinition } from "./types.js";

// ── Explicit tool instances ─────────────────────────────────────────
// Core tools registered by initializeTools(). Tool modules only export
// their definitions — registration happens exclusively here, so importing
// a tool module never mutates the registry.
//
// IMPORTANT: The imports above MUST be static (not dynamic `await import()`).
// When the daemon is compiled with `bun --compile`, dynamic imports with
// relative string literals resolve against the virtual `/$bunfs/root/`
// filesystem root rather than the module's own directory, causing
// "Cannot find module './filesystem/read.js'" crashes in production builds.
// Static imports are resolved at bundle time and are always safe.

export const explicitTools: ToolDefinition[] = [
  shellTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  codeSearchTool,
  webFetchTool,
  webSearchTool,
  skillExecuteTool,
  skillLoadTool,
  requestSystemPermissionTool,
  rememberTool,
  recallTool,
  notifyParentTool,
  askQuestionTool,
  // NOTE: external skill tools (registered via registerExternalTools in
  // registry.ts) are intentionally NOT included here. `explicitTools` is a
  // module-level const whose value is fixed at first evaluation, so
  // external tools registered after this file loads would be missed.
  // `initializeTools()` in `registry.ts` calls `getExternalTools()`
  // separately at runtime so late registrations are picked up.
];

// ── CES tools (feature-flag gated) ──────────────────────────────────
// Credential Execution Service tools are only registered when the
// CES feature flag (`ces-tools`) is enabled.
// This list is intentionally separate from `explicitTools` so that
// initializeTools() in registry.ts can conditionally include them.

/** All CES tools - stable references for the manifest snapshot. */
export const cesTools: ToolDefinition[] = [
  makeAuthenticatedRequestTool,
  runAuthenticatedCommandTool,
  manageSecureCommandTool,
];

/**
 * Return CES tools only if the CES feature flag is enabled.
 * Returns an empty array when the flag is disabled so callers can
 * unconditionally iterate the result.
 */
export function getCesToolsIfEnabled(): ToolDefinition[] {
  try {
    const config = getConfig();
    if (isCesToolsEnabled(config)) {
      // manage_secure_command_tool is additionally gated behind the
      // ces-secure-install flag so it can be rolled out independently.
      const secureInstallEnabled = isCesSecureInstallEnabled(config);
      return cesTools.filter(
        (t) => t.name !== "manage_secure_command_tool" || secureInstallEnabled,
      );
    }
  } catch {
    // Config not yet loaded (e.g. during test setup) - CES tools stay off.
  }
  return [];
}
