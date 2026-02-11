import { RiskLevel } from '../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import { getLogger } from '../util/logger.js';
import { registerComputerUseTools } from './computer-use/registry.js';
import { registerUiSurfaceTools } from './ui-surface/registry.js';

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
  if (tools.has(tool.name)) {
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

  // Computer-use proxy tools — registered so ToolExecutor can look them up
  // and forward execution to the connected macOS client.  They are excluded
  // from getAllToolDefinitions() since regular chat sessions don't use them.
  registerComputerUseTools();

  // UI surface proxy tools — registered so ToolExecutor can look them up
  // and forward surface show/update/dismiss to the connected macOS client.
  // Like CU tools, they are excluded from getAllToolDefinitions().
  registerUiSurfaceTools();

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

  log.info({ count: tools.size }, 'Tools initialized');
}
