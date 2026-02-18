import { describe, test, expect } from 'bun:test';
import { forwardComputerUseProxyTool } from '../tools/computer-use/skill-proxy-bridge.js';
import type { ToolContext, ToolExecutionResult } from '../tools/types.js';

describe('forwardComputerUseProxyTool', () => {
  test('returns error when proxyToolResolver is missing', async () => {
    const context = {} as ToolContext;
    const result = await forwardComputerUseProxyTool('computer_use_click', { x: 100, y: 200 }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no proxy resolver available');
    expect(result.content).toContain('computer_use_click');
  });

  test('forwards to proxyToolResolver when present', async () => {
    const expectedResult: ToolExecutionResult = {
      content: 'Clicked at (100, 200)',
      isError: false,
    };

    let capturedName = '';
    let capturedInput: Record<string, unknown> = {};

    const context = {
      proxyToolResolver: async (name: string, input: Record<string, unknown>) => {
        capturedName = name;
        capturedInput = input;
        return expectedResult;
      },
    } as unknown as ToolContext;

    const result = await forwardComputerUseProxyTool('computer_use_click', { x: 100, y: 200 }, context);

    expect(result).toBe(expectedResult);
    expect(capturedName).toBe('computer_use_click');
    expect(capturedInput).toEqual({ x: 100, y: 200 });
  });

  test('passes through isError from resolver result', async () => {
    const errorResult: ToolExecutionResult = {
      content: 'Element not found',
      isError: true,
    };

    const context = {
      proxyToolResolver: async () => errorResult,
    } as unknown as ToolContext;

    const result = await forwardComputerUseProxyTool('computer_use_click', {}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Element not found');
  });
});
