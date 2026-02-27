/**
 * Declarative tool manifest — single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { RiskLevel } from '../permissions/types.js';
import { accountManageTool } from './credentials/account-registry.js';
import { credentialStoreTool } from './credentials/vault.js';
import { memorySaveTool, memorySearchTool, memoryUpdateTool } from './memory/register.js';
import type { LazyToolDescriptor } from './registry.js';
import { vellumSkillsCatalogTool } from './skills/vellum-catalog.js';
import { setAvatarTool } from './system/avatar-generator.js';
import { navigateSettingsTabTool } from './system/navigate-settings.js';
import { openSystemSettingsTool } from './system/open-system-settings.js';
import { voiceConfigUpdateTool } from './system/voice-config.js';
import { shellTool } from './terminal/shell.js';
import type { Tool } from './types.js';
import { screenWatchTool } from './watch/screen-watch.js';
import { swarmDelegateTool } from './swarm/delegate.js';

// ── Eager side-effect modules ───────────────────────────────────────
// These static imports trigger top-level `registerTool()` side effects.
//
// IMPORTANT: These MUST be static imports (not dynamic `await import()`).
// When the daemon is compiled with `bun --compile`, dynamic imports with
// relative string literals resolve against the virtual `/$bunfs/root/`
// filesystem root rather than the module's own directory, causing
// "Cannot find module './filesystem/read.js'" crashes in production builds.
// Static imports are resolved at bundle time and are always safe.
import './assets/materialize.js';
import './assets/search.js';
import './filesystem/edit.js';
import './filesystem/read.js';
import './filesystem/view-image.js';
import './filesystem/write.js';
import './network/web-fetch.js';
import './network/web-search.js';
import './skills/delete-managed.js';
import './skills/load.js';
import './skills/scaffold-managed.js';
import './system/request-permission.js';
import './system/version.js';

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
  'file_read',
  'file_write',
  'file_edit',
  'web_search',
  'web_fetch',
  'skill_load',
  'scaffold_managed_skill',
  'delete_managed_skill',
  'request_system_permission',
  'asset_search',
  'asset_materialize',
  'view_image',
  'version',
];

// ── Explicit tool instances ─────────────────────────────────────────
// Tools exported as instances — registered by initializeTools() without
// relying on import side effects.

export const explicitTools: Tool[] = [
  memorySearchTool,
  memorySaveTool,
  memoryUpdateTool,
  credentialStoreTool,
  accountManageTool,
  screenWatchTool,
  vellumSkillsCatalogTool,
  voiceConfigUpdateTool,
  setAvatarTool,
  openSystemSettingsTool,
  navigateSettingsTabTool,
];

// ── Lazy tool descriptors ───────────────────────────────────────────
// Tools that defer module loading until first invocation.

export const lazyTools: LazyToolDescriptor[] = [
  {
    name: 'bash',
    description: 'Execute a shell command on the local machine',
    category: 'terminal',
    defaultRiskLevel: RiskLevel.Medium,
    definition: {
      name: 'bash',
      description: 'Execute a shell command on the local machine',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Optional timeout in seconds. Defaults to the configured default (120s). Cannot exceed the configured maximum.',
          },
          network_mode: {
            type: 'string',
            enum: ['off', 'proxied'],
            description: 'Network access mode for the command. "off" (default) blocks network access; "proxied" routes traffic through the credential proxy.',
          },
          credential_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of credential IDs to inject via the proxy when network_mode is "proxied".',
          },
        },
        required: ['command'],
      },
    },
    loader: async () => shellTool,
  },
  {
    name: 'swarm_delegate',
    description: 'Decompose a complex task into parallel specialist subtasks and execute them concurrently.',
    category: 'orchestration',
    defaultRiskLevel: RiskLevel.Medium,
    definition: {
      name: 'swarm_delegate',
      description: 'Decompose a complex task into parallel specialist subtasks and execute them concurrently. Use this for multi-part tasks that benefit from parallel research, coding, and review.',
      input_schema: {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            description: 'The complex task to decompose and execute in parallel',
          },
          context: {
            type: 'string',
            description: 'Optional additional context about the task or codebase',
          },
          max_workers: {
            type: 'number',
            description: 'Maximum concurrent workers (1-6, default from config)',
          },
        },
        required: ['objective'],
      },
    },
    loader: async () => swarmDelegateTool,
  },
];
