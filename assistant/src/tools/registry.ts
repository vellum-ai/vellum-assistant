import { RiskLevel } from '../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import { getLogger } from '../util/logger.js';
import { registerComputerUseTools } from './computer-use/registry.js';
import { registerUiSurfaceTools } from './ui-surface/registry.js';
import { registerAppTools } from './apps/registry.js';
import { hostFileReadTool } from './host-filesystem/read.js';
import { hostFileWriteTool } from './host-filesystem/write.js';
import { hostFileEditTool } from './host-filesystem/edit.js';
import { hostShellTool } from './host-terminal/host-shell.js';

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
  const { eagerModules, explicitTools, lazyTools } = await import('./tool-manifest.js');

  // Import tool modules to trigger registration side effects.
  for (const modulePath of eagerModules) {
    await import(modulePath);
  }

  // Explicit tool instances — no side-effect import required.
  for (const tool of explicitTools) {
    registerTool(tool);
  }

  // Host tools are registered explicitly so host access stays opt-in until
  // this point in startup, rather than as module side effects.
  registerTool(hostFileReadTool);
  registerTool(hostFileWriteTool);
  registerTool(hostFileEditTool);
  registerTool(hostShellTool);

  // Computer-use proxy tools — registered so ToolExecutor can look them up
  // and forward execution to the connected macOS client.  They are excluded
  // from getAllToolDefinitions() since regular chat sessions don't use them.
  registerComputerUseTools();
  registerUiSurfaceTools();
  registerAppTools();

  // Lazy tools — defer module loading until first invocation.
  for (const descriptor of lazyTools) {
    registerLazyTool(descriptor);
  }

  log.info({ count: tools.size }, 'Tools initialized');
}
