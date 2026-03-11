/**
 * Declarative tool manifest — single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { credentialStoreTool } from "./credentials/vault.js";
import {
  memoryDeleteTool,
  memoryRecallTool,
  memorySaveTool,
  memoryUpdateTool,
} from "./memory/register.js";
import type { LazyToolDescriptor } from "./registry.js";
import type { Tool } from "./types.js";

// ── Eager side-effect modules ───────────────────────────────────────
// These static imports trigger top-level `registerTool()` side effects.
//
// IMPORTANT: These MUST be static imports (not dynamic `await import()`).
// When the daemon is compiled with `bun --compile`, dynamic imports with
// relative string literals resolve against the virtual `/$bunfs/root/`
// filesystem root rather than the module's own directory, causing
// "Cannot find module './filesystem/read.js'" crashes in production builds.
// Static imports are resolved at bundle time and are always safe.
import "./assets/materialize.js";
import "./assets/search.js";
import "./filesystem/edit.js";
import "./filesystem/read.js";
import "./filesystem/view-image.js";
import "./filesystem/write.js";
import "./network/web-fetch.js";
import "./network/web-search.js";
import "./skills/load.js";
import "./system/request-permission.js";
import "./terminal/shell.js";

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
  "skill_load",
  "request_system_permission",
  "asset_search",
  "asset_materialize",
  "view_image",
];

// ── Explicit tool instances ─────────────────────────────────────────
// Tools exported as instances — registered by initializeTools() without
// relying on import side effects.

export const explicitTools: Tool[] = [
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
