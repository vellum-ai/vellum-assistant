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
import { setAvatarTool } from "./system/avatar-generator.js";
import { navigateSettingsTabTool } from "./system/navigate-settings.js";
import { openSystemSettingsTool } from "./system/open-system-settings.js";
import { voiceConfigUpdateTool } from "./system/voice-config.js";
import type { Tool } from "./types.js";
import { screenWatchTool } from "./watch/screen-watch.js";

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
import "./skills/delete-managed.js";
import "./skills/load.js";
import "./skills/scaffold-managed.js";
import "./swarm/delegate.js";
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
  "scaffold_managed_skill",
  "delete_managed_skill",
  "request_system_permission",
  "asset_search",
  "asset_materialize",
  "swarm_delegate",
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
  screenWatchTool,
  voiceConfigUpdateTool,
  setAvatarTool,
  openSystemSettingsTool,
  navigateSettingsTabTool,
];

// ── Lazy tool descriptors ───────────────────────────────────────────
// Tools that defer module loading until first invocation.
// bash and swarm_delegate were previously lazy but are now eagerly registered
// via side-effect imports above, preserving their full definitions (including
// the `reason` field on bash) and fixing bun --compile module-not-found crashes.

export const lazyTools: LazyToolDescriptor[] = [];
