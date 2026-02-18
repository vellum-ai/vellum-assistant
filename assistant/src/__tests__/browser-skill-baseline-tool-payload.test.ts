/**
 * Baseline characterization test — locks the current startup tool payload
 * shape before the browser skill migration.  If the migration accidentally
 * drops a browser tool or changes the payload envelope, this test fails.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  initializeTools,
  getAllTools,
  getAllToolDefinitions,
  __resetRegistryForTesting,
} from '../tools/registry.js';

afterAll(() => { __resetRegistryForTesting(); });

const BROWSER_TOOL_NAMES = [
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

beforeAll(async () => {
  await initializeTools();
});

describe('browser skill baseline — startup tool payload', () => {
  test('all 10 browser tools are present in the global registry', () => {
    const registeredNames = new Set(getAllTools().map((t) => t.name));

    for (const name of BROWSER_TOOL_NAMES) {
      expect(registeredNames.has(name)).toBe(true);
    }
  });

  test('all 10 browser tools appear in getAllToolDefinitions (non-proxy)', () => {
    const definitionNames = new Set(getAllToolDefinitions().map((d) => d.name));

    for (const name of BROWSER_TOOL_NAMES) {
      expect(definitionNames.has(name)).toBe(true);
    }
  });

  test('total tool definition count matches baseline', () => {
    const definitions = getAllToolDefinitions();
    // Current baseline is 41 definitions.  Use a range to tolerate minor
    // additions without breaking the characterization intent.
    expect(definitions.length).toBeGreaterThanOrEqual(38);
    expect(definitions.length).toBeLessThanOrEqual(50);
  });

  test('serialized tool definitions payload exceeds size floor', () => {
    const definitions = getAllToolDefinitions();
    const serialized = JSON.stringify(definitions);
    // Current baseline is ~24 000 chars.  A floor of 20 000 catches
    // accidental wholesale removal without being brittle to minor schema
    // tweaks.
    expect(serialized.length).toBeGreaterThan(20_000);
  });

  test('browser tools are categorised as "browser"', () => {
    const browserTools = getAllTools().filter((t) =>
      (BROWSER_TOOL_NAMES as readonly string[]).includes(t.name),
    );

    expect(browserTools.length).toBe(BROWSER_TOOL_NAMES.length);
    for (const tool of browserTools) {
      expect(tool.category).toBe('browser');
    }
  });
});
