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
import { resolveMemoryProvider } from "../memory/provider/resolve.js";
import { shouldBuiltinMemoryYield } from "../plugins/memory-capability.js";
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

// ── Memory tools (active-provider owned) ────────────────────────────
// The `remember`/`recall` tools are owned by the active memory provider:
// `initializeTools()` registers the tools the resolved provider contributes
// via `provideTools()`. The graph, v2, and v3 providers expose
// `remember`/`recall`; `none` exposes nothing, so a `memory.provider: "none"`
// install registers no memory tools.
//
// When an external `provides: "memory"` plugin is active (the
// `memory-plugin-provider` flag is on and exactly one such plugin is enabled),
// the built-in memory provider yields its tools too — the same condition the
// capability arbiter uses to drop the built-in memory hooks. Returning none
// here keeps the `remember`/`recall` names free so the external plugin's
// same-named tools register cleanly (instead of being skipped as core-tool
// conflicts), so the plugin owns capture as well as injection/consolidation.

/**
 * Return the memory tools the active provider contributes, resolved from the
 * current config. Returns an empty array when the built-in yields to an active
 * external memory plugin, when the provider exposes no tools (`none`), or when
 * config is not yet loaded (e.g. test setup) so callers can unconditionally
 * iterate the result.
 */
export function getMemoryToolsForActiveProvider(): ToolDefinition[] {
  try {
    if (shouldBuiltinMemoryYield()) return [];
    return resolveMemoryProvider(getConfig()).provideTools();
  } catch {
    // Config not yet loaded (e.g. during test setup) - no memory tools.
    return [];
  }
}
