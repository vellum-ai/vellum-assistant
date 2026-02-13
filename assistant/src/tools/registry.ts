import { RiskLevel } from '../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import { getLogger } from '../util/logger.js';
import { registerComputerUseTools } from './computer-use/registry.js';
import { registerUiSurfaceTools } from './ui-surface/registry.js';
import { registerAppTools } from './apps/registry.js';

const log = getLogger('tool-registry');

const tools = new Map<string, Tool>();

export interface LazyToolDescriptor {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  definition: ToolDefinition;
  loader: () => Promise<Tool>;
}

/**
 * A tool wrapper that exposes metadata eagerly but defers module loading
 * and execute() initialization until the tool is first invoked.
 */
class LazyTool implements Tool {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  private definition: ToolDefinition;
  private loader: () => Promise<Tool>;
  private resolvedTool: Tool | null = null;
  private loadPromise: Promise<Tool> | null = null;

  constructor(descriptor: LazyToolDescriptor) {
    this.name = descriptor.name;
    this.description = descriptor.description;
    this.category = descriptor.category;
    this.defaultRiskLevel = descriptor.defaultRiskLevel;
    this.definition = descriptor.definition;
    this.loader = descriptor.loader;
  }

  getDefinition(): ToolDefinition {
    return this.definition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (!this.resolvedTool) {
      if (!this.loadPromise) {
        this.loadPromise = this.loader().then((tool) => {
          this.resolvedTool = tool;
          log.info({ name: this.name }, 'Lazy tool loaded');
          return tool;
        }).catch((err) => {
          this.loadPromise = null;
          throw err;
        });
      }
      await this.loadPromise;
    }
    return this.resolvedTool!.execute(input, context);
  }
}

export function registerTool(tool: Tool): void {
  const existing = tools.get(tool.name);
  if (existing) {
    if (existing === tool) return; // same object, skip
    log.warn({ name: tool.name }, 'Tool already registered, overwriting');
  }
  tools.set(tool.name, tool);
  log.info({ name: tool.name, category: tool.category }, 'Tool registered');
}

export function registerLazyTool(descriptor: LazyToolDescriptor): void {
  const lazy = new LazyTool(descriptor);
  registerTool(lazy);
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function getAllTools(): Tool[] {
  return Array.from(tools.values());
}

export function getAllToolDefinitions(): ToolDefinition[] {
  // Exclude proxy tools (e.g. cu_* computer-use tools) — they are only used
  // by ComputerUseSession which builds its own tool definitions list.
  return getAllTools()
    .filter((t) => t.executionMode !== 'proxy')
    .map((t) => t.getDefinition());
}

export async function initializeTools(): Promise<void> {
  // Import tool modules to trigger registration side effects.
  // Filesystem and network tools are cheap to load — import eagerly.
  await import('./filesystem/read.js');
  await import('./filesystem/write.js');
  await import('./filesystem/edit.js');
  await import('./network/web-search.js');
  await import('./network/web-fetch.js');
  await import('./skills/load.js');
  await import('./browser/headless-browser.js');
  await import('./weather/get-weather.js');
  await import('./memory/register.js');
  await import('./credentials/vault.js');
  await import('./credentials/account-registry.js');
  await import('./timer/pomodoro.js');
  await import('./system/system-info.js');
  await import('./schedule/create.js');
  await import('./schedule/list.js');
  await import('./schedule/update.js');
  await import('./schedule/delete.js');

  // Computer-use proxy tools — registered so ToolExecutor can look them up
  // and forward execution to the connected macOS client.  They are excluded
  // from getAllToolDefinitions() since regular chat sessions don't use them.
  registerComputerUseTools();
  registerUiSurfaceTools();
  registerAppTools();

  // The bash tool loads web-tree-sitter WASM for command parsing, which is
  // expensive.  Register it lazily so the WASM is only loaded on first use.
  registerLazyTool({
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
      // Dynamically import the shell module.  Its side-effect registerTool()
      // call replaces the lazy wrapper in the map with the real tool.
      const mod = await import('./terminal/shell.js');
      return mod.shellTool;
    },
  });

  // Claude Code tool — delegates coding tasks to Claude Code via the Agent SDK.
  // Registered lazily since the SDK spawns a subprocess and is only needed on demand.
  registerLazyTool({
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
        },
        required: ['prompt'],
      },
    },
    loader: async () => {
      const mod = await import('./claude-code/claude-code.js');
      return mod.claudeCodeTool;
    },
  });

  log.info({ count: tools.size }, 'Tools initialized');
}
