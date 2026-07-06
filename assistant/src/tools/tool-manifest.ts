/**
 * Declarative tool manifest - single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { getConfig } from "../config/loader.js";
import { isMessageReactionsEnabled } from "../config/message-reactions-gate.js";
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
import { sendReactionTool } from "./reactions/send-reaction.js";
import { skillExecuteTool } from "./skills/execute.js";
import { skillLoadTool } from "./skills/load.js";
import { notifyParentTool } from "./subagent/notify-parent.js";
import { requestSystemPermissionTool } from "./system/request-permission.js";
import { shellTool } from "./terminal/shell.js";
import type { ToolDefinition } from "./types.js";

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
  "code_search",
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

export const explicitTools: ToolDefinition[] = [
  // Previously-eager tools - kept here so initializeTools() can re-register
  // them after __resetRegistryForTesting() clears the registry (ESM caching
  // prevents their side-effect registrations from re-running).
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
  // Always-explicit tools
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

// ── Message-reaction tools (feature-flag gated) ─────────────────────
// Registered only when the `message-reactions` flag is enabled, both at
// startup (initializeTools) and after the async gateway flag fetch
// resolves (syncFlagGatedTools).

/** All message-reaction tools - stable references for the manifest snapshot. */
export const messageReactionTools: ToolDefinition[] = [sendReactionTool];

/**
 * Return message-reaction tools only if the `message-reactions` flag is
 * enabled. Returns an empty array when the flag is disabled so callers
 * can unconditionally iterate the result.
 */
export function getMessageReactionToolsIfEnabled(): ToolDefinition[] {
  try {
    if (isMessageReactionsEnabled(getConfig())) {
      return messageReactionTools;
    }
  } catch {
    // Config not yet loaded (e.g. during test setup) - gated tools stay off.
  }
  return [];
}

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
