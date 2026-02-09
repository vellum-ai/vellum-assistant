import { describe, test, expect } from 'bun:test';
import { RiskLevel } from '../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../tools/types.js';
import type { ToolDefinition } from '../providers/types.js';

// We cannot import the private LazyTool class directly, so we test through
// registerLazyTool + getTool which exercise the same code path.
import { registerLazyTool, getTool } from '../tools/registry.js';

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
