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
  assertComputerUseToolsAbsent,
} from './test-support/computer-use-skill-harness.js';

afterAll(() => { __resetRegistryForTesting(); });

describe('computer-use skill baseline: registry tool surfaces', () => {
  test('no computer_use_* tools are registered after initializeTools() (migrated to skill)', async () => {
    await initializeTools();

    for (const name of COMPUTER_USE_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool).toBeUndefined();
    }
  });

  test('getAllToolDefinitions() excludes all computer_use_* tools (proxy exclusion)', async () => {
    await initializeTools();

    const defNames = getAllToolDefinitions().map((d) => d.name);
    assertComputerUseToolsAbsent(defNames);
  });

  test('getAllToolDefinitions() excludes computer_use_request_control (proxy exclusion)', async () => {
    await initializeTools();

    const defNames = getAllToolDefinitions().map((d) => d.name);
    expect(defNames).not.toContain('computer_use_request_control');
  });

  test('buildToolDefinitions() includes computer_use_request_control for text sessions', async () => {
    await initializeTools();

    const defNames = buildToolDefinitions().map((d) => d.name);
    expect(defNames).toContain('computer_use_request_control');
  });

  test('buildToolDefinitions() excludes all computer_use_* action tools from text sessions', async () => {
    await initializeTools();

    const defNames = buildToolDefinitions().map((d) => d.name);
    // The only computer_use_* tool in text sessions is the escalation tool
    const cuActionTools = defNames.filter(
      (n) => n.startsWith('computer_use_') && n !== 'computer_use_request_control',
    );
    expect(cuActionTools).toHaveLength(0);
  });

  test('post-cutover count: 0 computer_use_* tools in core registry', async () => {
    await initializeTools();

    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith('computer_use_'));
    expect(cuTools).toHaveLength(0);
  });
});
