import { describe, test, expect, afterAll } from 'bun:test';
import {
  getTool,
  getAllTools,
  getAllToolDefinitions,
  initializeTools,
  __resetRegistryForTesting,
} from '../tools/registry.js';
import { buildToolDefinitions } from '../daemon/session-tool-setup.js';
import {
  COMPUTER_USE_TOOL_NAMES,
  COMPUTER_USE_TOOL_COUNT,
  assertComputerUseToolsAbsent,
} from './test-support/computer-use-skill-harness.js';

afterAll(() => { __resetRegistryForTesting(); });

describe('computer-use skill baseline: registry tool surfaces', () => {
  test('all 12 computer_use_* tools are registered after initializeTools()', async () => {
    await initializeTools();

    for (const name of COMPUTER_USE_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      expect(tool?.executionMode).toBe('proxy');
    }
  });

  test('request_computer_control is registered after initializeTools()', async () => {
    await initializeTools();

    const tool = getTool('request_computer_control');
    expect(tool).toBeDefined();
    expect(tool?.executionMode).toBe('proxy');
  });

  test('getAllToolDefinitions() excludes all computer_use_* tools (proxy exclusion)', async () => {
    await initializeTools();

    const defNames = getAllToolDefinitions().map((d) => d.name);
    assertComputerUseToolsAbsent(defNames);
  });

  test('getAllToolDefinitions() excludes request_computer_control (proxy exclusion)', async () => {
    await initializeTools();

    const defNames = getAllToolDefinitions().map((d) => d.name);
    expect(defNames).not.toContain('request_computer_control');
  });

  test('buildToolDefinitions() includes request_computer_control for text sessions', async () => {
    await initializeTools();

    const defNames = buildToolDefinitions().map((d) => d.name);
    expect(defNames).toContain('request_computer_control');
  });

  test('buildToolDefinitions() excludes all computer_use_* tools from text sessions', async () => {
    await initializeTools();

    const defNames = buildToolDefinitions().map((d) => d.name);
    assertComputerUseToolsAbsent(defNames);
  });

  test('baseline count: 12 computer_use_* proxy tools in core registry', async () => {
    await initializeTools();

    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith('computer_use_'));
    expect(cuTools).toHaveLength(COMPUTER_USE_TOOL_COUNT);
  });
});
