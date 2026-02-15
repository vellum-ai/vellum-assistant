import { describe, test, expect } from 'bun:test';
import { RiskLevel } from '../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../tools/types.js';
import type { ToolDefinition } from '../providers/types.js';

// We cannot import the private LazyTool class directly, so we test through
// registerLazyTool + getTool which exercise the same code path.
import { registerLazyTool, getTool, getAllTools, getAllToolDefinitions, initializeTools } from '../tools/registry.js';
import { eagerModules, explicitTools, lazyTools } from '../tools/tool-manifest.js';

function makeFakeTool(name: string): Tool {
  return {
    name,
    description: `Fake ${name}`,
    category: 'test',
    defaultRiskLevel: RiskLevel.Low,
    getDefinition(): ToolDefinition {
      return {
        name,
        description: `Fake ${name}`,
        input_schema: { type: 'object', properties: {}, required: [] },
      };
    },
    async execute(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
      return { content: 'ok', isError: false };
    },
  };
}

describe('LazyTool', () => {
  test('clears cached promise on load failure so subsequent call can retry', async () => {
    let callCount = 0;

    registerLazyTool({
      name: 'test-retry-tool',
      description: 'A tool that fails on first load then succeeds',
      category: 'test',
      defaultRiskLevel: RiskLevel.Low,
      definition: {
        name: 'test-retry-tool',
        description: 'A tool that fails on first load then succeeds',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      loader: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient load failure');
        }
        return makeFakeTool('test-retry-tool');
      },
    });

    const tool = getTool('test-retry-tool')!;
    expect(tool).toBeDefined();

    const dummyContext = {} as ToolContext;

    // First call should throw the transient error
    await expect(tool.execute({}, dummyContext)).rejects.toThrow('transient load failure');
    expect(callCount).toBe(1);

    // Second call should retry the loader and succeed
    const result = await tool.execute({}, dummyContext);
    expect(result.content).toBe('ok');
    expect(result.isError).toBe(false);
    expect(callCount).toBe(2);
  });
});

describe('tool registry host tools', () => {
  test('registers host tools and exposes them in tool definitions', async () => {
    await initializeTools();

    const hostToolNames = ['host_file_read', 'host_file_write', 'host_file_edit', 'host_bash'] as const;

    for (const toolName of hostToolNames) {
      const tool = getTool(toolName);
      expect(tool).toBeDefined();
      expect(tool?.defaultRiskLevel).toBe(RiskLevel.Medium);
    }

    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    for (const toolName of hostToolNames) {
      expect(definitionNames).toContain(toolName);
    }
  });
});

describe('tool registry dynamic-tools tools', () => {
  test('registers evaluate, scaffold, delete, and skill_load tools', async () => {
    await initializeTools();

    const dynamicToolNames = [
      'evaluate_typescript_code',
      'scaffold_managed_skill',
      'delete_managed_skill',
      'skill_load',
    ] as const;

    for (const toolName of dynamicToolNames) {
      const tool = getTool(toolName);
      expect(tool).toBeDefined();
    }

    const definitionNames = getAllToolDefinitions().map((def) => def.name);
    for (const toolName of dynamicToolNames) {
      expect(definitionNames).toContain(toolName);
    }
  });

  test('evaluate_typescript_code is registered as High risk', async () => {
    await initializeTools();
    const tool = getTool('evaluate_typescript_code');
    expect(tool).toBeDefined();
    expect(tool?.defaultRiskLevel).toBe(RiskLevel.High);
  });

  test('scaffold and delete are registered as High risk', async () => {
    await initializeTools();
    for (const name of ['scaffold_managed_skill', 'delete_managed_skill']) {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      expect(tool?.defaultRiskLevel).toBe(RiskLevel.High);
    }
  });

  test('skill_load is registered as Low risk', async () => {
    await initializeTools();
    const tool = getTool('skill_load');
    expect(tool).toBeDefined();
    expect(tool?.defaultRiskLevel).toBe(RiskLevel.Low);
  });
});

describe('tool manifest', () => {
  test('all manifest lazy tools are registered after init', async () => {
    await initializeTools();
    const registered = new Set(getAllTools().map((t) => t.name));

    for (const descriptor of lazyTools) {
      expect(registered.has(descriptor.name)).toBe(true);
    }
  });

  test('manifest declares expected core lazy tools', () => {
    const lazyNames = new Set(lazyTools.map((t) => t.name));
    expect(lazyNames.has('bash')).toBe(true);
    expect(lazyNames.has('evaluate_typescript_code')).toBe(true);
    expect(lazyNames.has('claude_code')).toBe(true);
    expect(lazyNames.has('swarm_delegate')).toBe(true);
  });

  test('eager module list contains expected count', () => {
    expect(eagerModules.length).toBe(15);
  });

  test('explicit tools list includes memory, credential, and timer tools', () => {
    const names = explicitTools.map((t) => t.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_update');
    expect(names).toContain('credential_store');
    expect(names).toContain('account_manage');
    expect(names).toContain('pomodoro');
  });

  test('registered tool count is at least eager + lazy + host', async () => {
    await initializeTools();
    const tools = getAllTools();
    expect(tools.length).toBeGreaterThanOrEqual(eagerModules.length + lazyTools.length);
  });
});
