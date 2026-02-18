import { join } from 'node:path';
import { describe, test, expect, beforeAll } from 'bun:test';
import {
  initializeTools,
  getAllTools,
  getTool,
  getAllToolDefinitions,
  __resetRegistryForTesting,
} from '../tools/registry.js';
import { buildToolDefinitions } from '../daemon/session-tool-setup.js';
import { getBundledSkillsDir } from '../config/skills.js';
import { parseToolManifestFile } from '../skills/tool-manifest.js';
import {
  COMPUTER_USE_TOOL_NAMES,
  COMPUTER_USE_TOOL_COUNT,
} from './test-support/computer-use-skill-harness.js';

beforeAll(async () => {
  __resetRegistryForTesting();
  await initializeTools();
});

describe('computer-use skill end-state', () => {
  // ── Core Registry ──────────────────────────────────────────────────

  test('core registry contains 0 computer_use_* tools', () => {
    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith('computer_use_'));
    expect(cuTools).toHaveLength(0);
  });

  test('no individual computer_use_* tool is resolvable from core registry', () => {
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(getTool(name)).toBeUndefined();
    }
  });

  test('request_computer_control is still present in core registry', () => {
    const tool = getTool('request_computer_control');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('request_computer_control');
  });

  // ── getAllToolDefinitions (excludes proxy & skill tools) ──────────

  test('getAllToolDefinitions() excludes computer_use_* tools', () => {
    const defs = getAllToolDefinitions();
    const cuDefs = defs.filter((d) => d.name.startsWith('computer_use_'));
    expect(cuDefs).toHaveLength(0);
  });

  test('getAllToolDefinitions() excludes request_computer_control (proxy exclusion)', () => {
    const defs = getAllToolDefinitions();
    const found = defs.find((d) => d.name === 'request_computer_control');
    expect(found).toBeUndefined();
  });

  // ── buildToolDefinitions (text session tool set) ─────────────────

  test('buildToolDefinitions() includes request_computer_control', () => {
    const defs = buildToolDefinitions();
    const found = defs.find((d) => d.name === 'request_computer_control');
    expect(found).toBeDefined();
  });

  test('buildToolDefinitions() excludes computer_use_* action tools', () => {
    const defs = buildToolDefinitions();
    const cuDefs = defs.filter((d) => d.name.startsWith('computer_use_'));
    expect(cuDefs).toHaveLength(0);
  });

  // ── Bundled Skill Catalog ────────────────────────────────────────

  test('computer-use skill has exactly ' + COMPUTER_USE_TOOL_COUNT + ' tools in TOOLS.json', () => {
    const manifestPath = join(getBundledSkillsDir(), 'computer-use', 'TOOLS.json');
    const manifest = parseToolManifestFile(manifestPath);
    expect(manifest.tools).toHaveLength(COMPUTER_USE_TOOL_COUNT);
  });

  test('bundled skill tool names match expected computer_use_* names', () => {
    const manifestPath = join(getBundledSkillsDir(), 'computer-use', 'TOOLS.json');
    const manifest = parseToolManifestFile(manifestPath);
    const toolNames = new Set(manifest.tools.map((t) => t.name));
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(toolNames.has(name)).toBe(true);
    }
  });
});
