import { describe, test, expect, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTools, __resetRegistryForTesting } from '../tools/registry.js';
import { allComputerUseTools } from '../tools/computer-use/definitions.js';
import { COMPUTER_USE_TOOL_NAMES, COMPUTER_USE_TOOL_COUNT } from './test-support/computer-use-skill-harness.js';

afterAll(() => { __resetRegistryForTesting(); });

// Load the TOOLS.json manifest
const manifestPath = resolve(import.meta.dirname, '../config/bundled-skills/computer-use/TOOLS.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

describe('computer-use skill manifest regression', () => {
  test('manifest has exactly 12 tools', () => {
    expect(manifest.tools).toHaveLength(COMPUTER_USE_TOOL_COUNT);
  });

  test('manifest version is 1', () => {
    expect(manifest.version).toBe(1);
  });

  test('manifest tool names match harness constants', () => {
    const manifestNames = manifest.tools.map((t: { name: string }) => t.name);
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(manifestNames).toContain(name);
    }
    // No extra tools
    expect(manifestNames).toHaveLength(COMPUTER_USE_TOOL_COUNT);
  });

  test('all manifest tools have execution_target: host', () => {
    for (const tool of manifest.tools) {
      expect(tool.execution_target).toBe('host');
    }
  });

  test('all manifest tools have risk: low', () => {
    for (const tool of manifest.tools) {
      expect(tool.risk).toBe('low');
    }
  });

  test('all manifest tools have category: computer-use', () => {
    for (const tool of manifest.tools) {
      expect(tool.category).toBe('computer-use');
    }
  });

  test('manifest descriptions match core definitions', async () => {
    await initializeTools();

    for (const cuTool of allComputerUseTools) {
      const def = cuTool.getDefinition();
      const manifestTool = manifest.tools.find((t: { name: string }) => t.name === def.name);
      expect(manifestTool).toBeDefined();
      expect(manifestTool.description).toBe(def.description);
    }
  });

  test('manifest input_schema matches core definitions', async () => {
    await initializeTools();

    for (const cuTool of allComputerUseTools) {
      const def = cuTool.getDefinition();
      const manifestTool = manifest.tools.find((t: { name: string }) => t.name === def.name);
      expect(manifestTool).toBeDefined();
      expect(manifestTool.input_schema).toEqual(def.input_schema);
    }
  });
});
