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
import { RiskLevel } from "../permissions/types.js";
import { executeAdvisorConsult } from "./advisor/consult.js";
import { askQuestionTool } from "./ask-question/ask-question-tool.js";
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
import { finalizeTool } from "./tool-defaults.js";
import type { Tool, ToolDefinition } from "./types.js";

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

export const explicitTools: ToolDefinition[] = [
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

// ── Advisor tool ────────────────────────────────────────────────────
// Always-on core tool whose per-turn visibility is gated by
// `conversation-tool-setup.ts`: it is exposed to the model only when a
// strictly-more-capable model is configured for the conversation's current
// executor. The gate lives in the tool-projection layer, not here, because
// it depends on per-conversation executor state.

const advisorTool: ToolDefinition = {
  name: "advisor",
  description:
    "Consult a higher-tier model that sees your full conversation. Call it BEFORE substantive work (before writing or committing to an approach), when stuck (errors recurring, approach not converging), and before declaring a task done. Read-only orientation (ls/grep/cat) is not substantive work and does not need a call. Takes no required arguments; pass an optional `focus` to ask about a specific decision.",
  defaultRiskLevel: RiskLevel.Low,
  category: "orchestration",
  input_schema: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description:
          "Optional specific question or decision to focus the advisor on. Omit for a general review of the work so far.",
      },
    },
    additionalProperties: false,
  },
  execute: (input, context) => executeAdvisorConsult(input, context),
};

/** Finalized advisor tool, registered by `initializeTools()` in registry.ts. */
export function getAdvisorTool(): Tool {
  return finalizeTool(advisorTool, "advisor");
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
