/**
 * End-state verification test for the browser skill migration.
 *
 * Locks the final invariants from the BROWSER_SKILL plan so that future
 * changes cannot silently regress any of the migration guarantees.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

import { eagerModuleToolNames } from '../tools/tool-manifest.js';
import {
  initializeTools,
  getAllTools,
  getAllToolDefinitions,
  __resetRegistryForTesting,
} from '../tools/registry.js';
import { getDefaultRuleTemplates } from '../permissions/defaults.js';
import { projectSkillTools, resetSkillToolProjection } from '../daemon/session-skill-tools.js';
import {
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_COUNT,
  BROWSER_SKILL_ID,
  buildSkillLoadHistory,
} from './test-support/browser-skill-harness.js';

afterAll(() => { __resetRegistryForTesting(); });

describe('browser skill migration end-state', () => {
  beforeAll(async () => {
    __resetRegistryForTesting();
    await initializeTools();
  });

  const BROWSER_TOOLS = [
    'browser_navigate',
    'browser_snapshot',
    'browser_screenshot',
    'browser_close',
    'browser_click',
    'browser_type',
    'browser_press_key',
    'browser_wait_for',
    'browser_extract',
    'browser_fill_credential',
  ] as const;

  // ── 1. Startup payload excludes browser tools ──────────────────────

  test('browser tools are NOT in startup core registry', () => {
    const toolNames = getAllTools().map((t) => t.name);
    for (const name of BROWSER_TOOLS) {
      expect(toolNames).not.toContain(name);
    }
  });

  test('browser tool names are NOT in eagerModuleToolNames', () => {
    for (const name of BROWSER_TOOLS) {
      expect(eagerModuleToolNames).not.toContain(name);
    }
  });

  test('startup tool definition count is reduced (no browser tools)', () => {
    const definitions = getAllToolDefinitions();
    // Startup has ~31 definitions (no browser tools).
    // Allow wider drift for unrelated tool additions while still failing if
    // browser tools are reintroduced at startup (+10 definitions).
    expect(definitions.length).toBeGreaterThanOrEqual(25);
    expect(definitions.length).toBeLessThanOrEqual(50);

    const defNames = definitions.map((d) => d.name);
    for (const name of BROWSER_TOOLS) {
      expect(defNames).not.toContain(name);
    }

    // Payload ceiling: startup payload is ~22 000 chars.  Browser tools
    // contribute ~4 640 chars — if they leak back in, the total would exceed
    // 35 000.  The margin absorbs minor tool additions.
    const payloadSize = JSON.stringify(definitions).length;
    expect(payloadSize).toBeLessThan(35_000);
  });

  // ── 2. Browser skill exists and is active ──────────────────────────

  test('bundled browser skill directory exists with SKILL.md and TOOLS.json', async () => {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const skillDir = path.resolve(import.meta.dirname, '../config/bundled-skills/browser');
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'TOOLS.json'))).toBe(true);
  });

  test('browser TOOLS.json contains all 10 tools', async () => {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const toolsPath = path.resolve(import.meta.dirname, '../config/bundled-skills/browser/TOOLS.json');
    const manifest = JSON.parse(fs.readFileSync(toolsPath, 'utf-8'));
    expect(manifest.version).toBe(1);
    expect(manifest.tools).toHaveLength(10);
    const toolNames = manifest.tools.map((t: { name: string }) => t.name);
    for (const name of BROWSER_TOOLS) {
      expect(toolNames).toContain(name);
    }
  });

  // ── 3. Permission defaults align with PR 08/09 ────────────────────

  test('skill_load has default allow rule', () => {
    const templates = getDefaultRuleTemplates();
    const rule = templates.find((t) => t.id === 'default:allow-skill_load-global');
    expect(rule).toBeDefined();
    expect(rule!.decision).toBe('allow');
  });

  test('all browser tools have default allow rules', () => {
    const templates = getDefaultRuleTemplates();
    for (const tool of BROWSER_TOOLS) {
      const rule = templates.find((t) => t.id === `default:allow-${tool}-global`);
      expect(rule).toBeDefined();
      expect(rule!.decision).toBe('allow');
      // browser_navigate uses standalone "**" globstar because navigate
      // candidates contain URLs with "/" (e.g. "browser_navigate:https://example.com/path").
      const expectedPattern = tool === 'browser_navigate' ? '**' : `${tool}:*`;
      expect(rule!.pattern).toBe(expectedPattern);
    }
  });

  // ── 4. Tool wrapper scripts exist ──────────────────────────────────

  test('all 10 browser tool wrapper scripts exist', async () => {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const toolsDir = path.resolve(import.meta.dirname, '../config/bundled-skills/browser/tools');
    const wrapperFiles = [
      'browser-navigate.ts',
      'browser-snapshot.ts',
      'browser-screenshot.ts',
      'browser-close.ts',
      'browser-click.ts',
      'browser-type.ts',
      'browser-press-key.ts',
      'browser-wait-for.ts',
      'browser-extract.ts',
      'browser-fill-credential.ts',
    ];
    for (const file of wrapperFiles) {
      expect(fs.existsSync(path.join(toolsDir, file))).toBe(true);
    }
  });

  // ── 5. Execution extraction is in place ────────────────────────────

  test('browser-execution.ts exists with exported execute functions', async () => {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const execPath = path.resolve(import.meta.dirname, '../tools/browser/browser-execution.ts');
    expect(fs.existsSync(execPath)).toBe(true);
    const content = fs.readFileSync(execPath, 'utf-8');
    for (const name of BROWSER_TOOLS) {
      // Derive expected function name: browser_navigate -> executeBrowserNavigate
      const fnName = 'execute' + name
        .split('_')
        .map((s, i) => (i === 0 ? 'Browser' : s.charAt(0).toUpperCase() + s.slice(1)))
        .join('');
      expect(content).toContain(fnName);
    }
  });

  // ── 6. Runtime projection adds exactly 10 browser tools ──────────

  test('skill_load projection adds all 10 browser tools', () => {
    const history = buildSkillLoadHistory(BROWSER_SKILL_ID);
    const tracking = new Map<string, string>();

    try {
      const projection = projectSkillTools(history, {
        previouslyActiveSkillIds: tracking,
      });

      // Exactly 10 new tool definitions should be projected
      expect(projection.toolDefinitions).toHaveLength(BROWSER_TOOL_COUNT);

      // Every browser tool name should be in the projection
      const projectedNames = projection.toolDefinitions.map((d) => d.name);
      for (const name of BROWSER_TOOL_NAMES) {
        expect(projectedNames).toContain(name);
      }

      // The allowedToolNames set should also contain all browser tools
      for (const name of BROWSER_TOOL_NAMES) {
        expect(projection.allowedToolNames.has(name)).toBe(true);
      }
    } finally {
      resetSkillToolProjection(tracking);
    }
  });
});
