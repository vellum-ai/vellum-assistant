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
import { makeAuthenticatedRequestTool } from "./credential-execution/make-authenticated-request.js";
import { manageSecureCommandTool } from "./credential-execution/manage-secure-command-tool.js";
import { runAuthenticatedCommandTool } from "./credential-execution/run-authenticated-command.js";
import { credentialStoreTool } from "./credentials/vault.js";
import { fileEditTool } from "./filesystem/edit.js";
import { fileListTool } from "./filesystem/list.js";
import { fileReadTool } from "./filesystem/read.js";
import { fileWriteTool } from "./filesystem/write.js";
import { recallTool, rememberTool } from "./memory/register.js";
import { webFetchTool } from "./network/web-fetch.js";
import { webSearchTool } from "./network/web-search.js";
import { skillExecuteTool } from "./skills/execute.js";
import { skillLoadTool } from "./skills/load.js";
import { notifyParentTool } from "./subagent/notify-parent.js";
import { requestSystemPermissionTool } from "./system/request-permission.js";
import { shellTool } from "./terminal/shell.js";
import type { Tool } from "./types.js";

// ── External tool registry ───────────────────────────────────────────
// Skills register their tools here at initialization time so the tool
// manifest can include them without importing from `../skills/`.
const externalTools: Tool[] = [];

/**
 * Register tools provided by an external skill. Called during skill
 * initialization (e.g. from `skills/meet-join/register.ts`).
 */
export function registerExternalTools(tools: Tool[]): void {
  externalTools.push(...tools);
}

/** Return all externally registered tools. */
export function getExternalTools(): Tool[] {
  return [...externalTools];
}

// ── Eager side-effect modules ───────────────────────────────────────
// These static imports trigger top-level `registerTool()` side effects on
// first evaluation. The named imports above serve double duty: they give us
// module-level references to each tool instance so that initializeTools()
// can explicitly re-register them after a test registry reset (ESM caching
// prevents side effects from re-running on subsequent imports).
//
// IMPORTANT: These MUST be static imports (not dynamic `await import()`).
// When the daemon is compiled with `bun --compile`, dynamic imports with
// relative string literals resolve against the virtual `/$bunfs/root/`
// filesystem root rather than the module's own directory, causing
// "Cannot find module './filesystem/read.js'" crashes in production builds.
// Static imports are resolved at bundle time and are always safe.

// loadEagerModules is a no-op now that all eager registrations happen via
// static imports above. Kept for API compatibility with registry.ts callers.
export function loadEagerModules(): Promise<void> {
  return Promise.resolve();
}

// Tool names registered by the eager modules above.  Listed explicitly so
// initializeTools() can recognise ESM-cached eager-module tools that were
// already in the registry before init ran (e.g. when a test file imports
// an eager module at the top level).
export const eagerModuleToolNames: string[] = [
  "bash",
  "file_read",
  "file_write",
  "file_edit",
  "file_list",
  "web_search",
  "web_fetch",
  "skill_execute",
  "skill_load",
  "request_system_permission",
  "notify_parent",
];

// ── Explicit tool instances ─────────────────────────────────────────
// Tools registered by initializeTools() via explicit instance references.
// This includes both previously-eager tools (referenced here so they survive
// a test registry reset) and tools that have always been explicit.

export const explicitTools: Tool[] = [
  // Previously-eager tools - kept here so initializeTools() can re-register
  // them after __resetRegistryForTesting() clears the registry (ESM caching
  // prevents their side-effect registrations from re-running).
  shellTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  webFetchTool,
  webSearchTool,
  skillExecuteTool,
  skillLoadTool,
  requestSystemPermissionTool,
  // Always-explicit tools
  rememberTool,
  recallTool,
  credentialStoreTool,
  notifyParentTool,
  // Meet tools are registered via registerExternalTools() during skill
  // initialization — the assistant never imports directly from skills/.
  ...getExternalTools(),
];

// ── CES tools (feature-flag gated) ──────────────────────────────────
// Credential Execution Service tools are only registered when the
// CES feature flag (`ces-tools`) is enabled.
// This list is intentionally separate from `explicitTools` so that
// initializeTools() in registry.ts can conditionally include them.

/** All CES tools - stable references for the manifest snapshot. */
export const cesTools: Tool[] = [
  makeAuthenticatedRequestTool,
  runAuthenticatedCommandTool,
  manageSecureCommandTool,
];

/**
 * Return CES tools only if the CES feature flag is enabled.
 * Returns an empty array when the flag is disabled so callers can
 * unconditionally iterate the result.
 */
export function getCesToolsIfEnabled(): Tool[] {
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
