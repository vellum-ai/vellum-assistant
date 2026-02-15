/**
 * Declarative tool manifest — single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { RiskLevel } from '../permissions/types.js';
import type { LazyToolDescriptor } from './registry.js';

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
  './browser/headless-browser.js',
  './weather/get-weather.js',
  './memory/register.js',
  './credentials/vault.js',
  './credentials/account-registry.js',
  './timer/pomodoro.js',
  './system/system-info.js',
  './schedule/create.js',
  './schedule/list.js',
  './schedule/update.js',
  './schedule/delete.js',
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
    name: 'claude_code',
    description: 'Delegate a coding task to Claude Code, an AI-powered coding agent that can read, write, and edit files, run shell commands, and perform complex multi-step software engineering tasks autonomously.',
    category: 'coding',
    defaultRiskLevel: RiskLevel.Medium,
    definition: {
      name: 'claude_code',
      description: 'Delegate a coding task to Claude Code, an AI-powered coding agent that can read, write, and edit files, run shell commands, and perform complex multi-step software engineering tasks autonomously.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The coding task or question for Claude Code to work on',
          },
          working_dir: {
            type: 'string',
            description: 'Working directory for Claude Code (defaults to session working directory)',
          },
          resume: {
            type: 'string',
            description: 'Claude Code session ID to resume a previous session',
          },
          model: {
            type: 'string',
            description: 'Model to use (defaults to claude-sonnet-4-5-20250929)',
          },
          profile: {
            type: 'string',
            enum: ['general', 'researcher', 'coder', 'reviewer'],
            description: 'Worker profile that scopes tool access. Defaults to general (backward compatible).',
          },
        },
        required: ['prompt'],
      },
    },
    loader: async () => {
      const mod = await import('./claude-code/claude-code.js');
      return mod.claudeCodeTool;
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
