/**
 * Declarative tool manifest — single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { assetMaterializeTool } from "./assets/materialize.js";
import { assetSearchTool } from "./assets/search.js";
import { credentialStoreTool } from "./credentials/vault.js";
import { fileEditTool } from "./filesystem/edit.js";
import { fileReadTool } from "./filesystem/read.js";
import { fileWriteTool } from "./filesystem/write.js";
import {
  memoryDeleteTool,
  memoryRecallTool,
  memorySaveTool,
  memoryUpdateTool,
} from "./memory/register.js";
import { webFetchTool } from "./network/web-fetch.js";
import { webSearchTool } from "./network/web-search.js";
import type { LazyToolDescriptor } from "./registry.js";
import { skillExecuteTool } from "./skills/execute.js";
import { skillLoadTool } from "./skills/load.js";
import { requestSystemPermissionTool } from "./system/request-permission.js";
import { shellTool } from "./terminal/shell.js";
import type { Tool } from "./types.js";

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
  "web_search",
  "web_fetch",
  "skill_execute",
  "skill_load",
  "request_system_permission",
  "asset_search",
  "asset_materialize",
];

// ── Explicit tool instances ─────────────────────────────────────────
// Tools registered by initializeTools() via explicit instance references.
// This includes both previously-eager tools (referenced here so they survive
// a test registry reset) and tools that have always been explicit.

export const explicitTools: Tool[] = [
  // Previously-eager tools — kept here so initializeTools() can re-register
  // them after __resetRegistryForTesting() clears the registry (ESM caching
  // prevents their side-effect registrations from re-running).
  shellTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  webFetchTool,
  webSearchTool,
  skillExecuteTool,
  skillLoadTool,
  requestSystemPermissionTool,
  assetSearchTool,
  assetMaterializeTool,
  // Always-explicit tools
  memorySaveTool,
  memoryUpdateTool,
  memoryDeleteTool,
  memoryRecallTool,
  credentialStoreTool,
];

// ── Lazy tool descriptors ───────────────────────────────────────────
// Tools that defer module loading until first invocation.
// bash was previously lazy but is now eagerly registered via side-effect
// imports above, preserving its full definition (including the `reason` field)
// and fixing bun --compile module-not-found crashes.
// swarm_delegate has been moved to the orchestration bundled skill.

export const lazyTools: LazyToolDescriptor[] = [];
