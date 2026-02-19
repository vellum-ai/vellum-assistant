/**
 * Declarative tool manifest — single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { RiskLevel } from '../permissions/types.js';
import type { LazyToolDescriptor } from './registry.js';
import type { Tool } from './types.js';
import { memorySearchTool, memorySaveTool, memoryUpdateTool } from './memory/register.js';
import { credentialStoreTool } from './credentials/vault.js';
import { accountManageTool } from './credentials/account-registry.js';
import { reminderTool } from './reminder/reminder.js';
import { screenWatchTool } from './watch/screen-watch.js';
import { vellumSkillsCatalogTool } from './skills/vellum-catalog.js';
import { documentCreateTool, documentUpdateTool } from './document/index.js';
import { cliDiscoverTool } from './host-terminal/cli-discover.js';
import { followupCreateTool, followupListTool, followupResolveTool } from './followups/index.js';
import { taskSaveTool, taskRunTool, taskListTool, taskDeleteTool, taskListShowTool, taskListAddTool, taskListUpdateTool } from './tasks/index.js';
import {
  subagentSpawnTool,
  subagentStatusTool,
  subagentAbortTool,
  subagentMessageTool,
  subagentReadTool,
} from './subagent/index.js';

// ── Eager side-effect modules ───────────────────────────────────────
// Importing these modules triggers a top-level `registerTool()` call.

export const eagerModules: string[] = [
  './filesystem/read.js',
  './filesystem/write.js',
  './filesystem/edit.js',
  './network/web-search.js',
  './network/web-fetch.js',
  './skills/load.js',
  './skills/scaffold-managed.js',
  './skills/delete-managed.js',
  './system/request-permission.js',
  './schedule/create.js',
  './schedule/list.js',
  './schedule/update.js',
  './schedule/delete.js',
  './watcher/create.js',
  './watcher/list.js',
  './watcher/update.js',
  './watcher/delete.js',
  './watcher/digest.js',
  './playbooks/playbook-create.js',
  './playbooks/playbook-list.js',
  './playbooks/playbook-update.js',
  './playbooks/playbook-delete.js',
  './contacts/contact-upsert.js',
  './contacts/contact-search.js',
  './contacts/contact-merge.js',
  './assets/search.js',
  './assets/materialize.js',
  './filesystem/view-image.js',
];

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
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
  'watcher_create',
  'watcher_list',
  'watcher_update',
  'watcher_delete',
  'watcher_digest',
  'playbook_create',
  'playbook_list',
  'playbook_update',
  'playbook_delete',
  'contact_upsert',
  'contact_search',
  'contact_merge',
  'asset_search',
  'asset_materialize',
  'view_image',
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
  reminderTool,
  screenWatchTool,
  vellumSkillsCatalogTool,
  documentCreateTool,
  documentUpdateTool,
  cliDiscoverTool,
  followupCreateTool,
  followupListTool,
  followupResolveTool,
  taskSaveTool,
  taskRunTool,
  taskListTool,
  taskDeleteTool,
  taskListShowTool,
  taskListAddTool,
  taskListUpdateTool,
  subagentSpawnTool,
  subagentStatusTool,
  subagentAbortTool,
  subagentMessageTool,
  subagentReadTool,
];

// ── Lazy tool descriptors ───────────────────────────────────────────
// Tools that defer module loading until first invocation.

export const lazyTools: LazyToolDescriptor[] = [
  {
    name: 'evaluate_typescript_code',
    description: 'Evaluate a TypeScript snippet in an isolated sandbox. Use this to test code before persisting it as a managed skill.',
    category: 'terminal',
    defaultRiskLevel: RiskLevel.High,
    definition: {
      name: 'evaluate_typescript_code',
      description: 'Evaluate a TypeScript snippet in an isolated sandbox. Use this to test code before persisting it as a managed skill.',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The TypeScript source code to evaluate. Must export a `default` or `run` function.',
          },
          mock_input_json: {
            type: 'string',
            description: 'Optional JSON string to pass as input. Defaults to "{}".',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Optional timeout in seconds (1-20). Defaults to 10.',
          },
          filename: {
            type: 'string',
            description: 'Optional filename for the snippet (default: "snippet.ts").',
          },
          entrypoint: {
            type: 'string',
            enum: ['default', 'run'],
            description: 'Which export to call: "default" or "run". Defaults to "default".',
          },
          max_output_chars: {
            type: 'number',
            description: 'Optional max output characters (1-25000). Defaults to 25000.',
          },
        },
        required: ['code'],
      },
    },
    loader: async () => {
      const mod = await import('./terminal/evaluate-typescript.js');
      return mod.evaluateTypescriptTool;
    },
  },
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
    loader: async () => {
      const mod = await import('./terminal/shell.js');
      return mod.shellTool;
    },
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
    loader: async () => {
      const mod = await import('./swarm/delegate.js');
      return mod.swarmDelegateTool;
    },
  },
];
