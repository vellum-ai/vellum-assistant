import { describe, test, expect, afterAll } from 'bun:test';
import {
  getTool,
  getAllTools,
  getAllToolDefinitions,
  initializeTools,
  __resetRegistryForTesting,
} from '../tools/registry.js';

// Import buildToolDefinitions which assembles the text-session tool set
import { buildToolDefinitions } from '../daemon/session-tool-setup.js';

// Clean up global registry after this file completes
afterAll(() => { __resetRegistryForTesting(); });

// The 12 computer_use_* tool names that exist in the core registry today
const COMPUTER_USE_TOOL_NAMES = [
  'computer_use_click',
  'computer_use_double_click',
  'computer_use_right_click',
  'computer_use_type_text',
  'computer_use_key',
  'computer_use_scroll',
  'computer_use_drag',
  'computer_use_wait',
  'computer_use_open_app',
  'computer_use_run_applescript',
  'computer_use_done',
  'computer_use_respond',
] as const;

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
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(defNames).not.toContain(name);
    }
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
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(defNames).not.toContain(name);
    }
  });

  test('baseline count: 12 computer_use_* proxy tools in core registry', async () => {
    await initializeTools();

    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith('computer_use_'));
    // After cutover (PR 09), this count should drop to 0 in the core registry.
    expect(cuTools).toHaveLength(12);
  });
});
