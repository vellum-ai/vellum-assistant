/**
 * Post-cutover characterization test — verifies that browser tools are NO
 * LONGER in the startup core tool payload.  They are now provided by the
 * bundled browser skill and only appear after skill_load activation.
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
  // Reset first to clear any browser tools registered via ESM side-effect
  // imports from other test files running in the same process.
  __resetRegistryForTesting();
  await initializeTools();
});

describe('browser skill cutover — startup tool payload', () => {
  test('no browser tools are present in the global registry at startup', () => {
    const registeredNames = new Set(getAllTools().map((t) => t.name));

    for (const name of BROWSER_TOOL_NAMES) {
      expect(registeredNames.has(name)).toBe(false);
    }
  });

  test('no browser tools appear in getAllToolDefinitions at startup', () => {
    const definitionNames = new Set(getAllToolDefinitions().map((d) => d.name));

    for (const name of BROWSER_TOOL_NAMES) {
      expect(definitionNames.has(name)).toBe(false);
    }
  });

  test('total tool definition count reflects removal of 10 browser tools', () => {
    const definitions = getAllToolDefinitions();
    // Previous baseline was ~41 definitions.  With 10 browser tools removed,
    // expect ~31.  Use a range to tolerate minor additions.
    expect(definitions.length).toBeGreaterThanOrEqual(28);
    expect(definitions.length).toBeLessThanOrEqual(40);
  });

  test('serialized tool definitions payload still exceeds a reasonable floor', () => {
    const definitions = getAllToolDefinitions();
    const serialized = JSON.stringify(definitions);
    // With 10 browser tools removed, the payload shrinks but should still
    // be substantial.  A floor of 15 000 catches accidental wholesale
    // removal without being brittle.
    expect(serialized.length).toBeGreaterThan(15_000);
  });

  test('no browser-categorised tools remain in startup registry', () => {
    const browserTools = getAllTools().filter((t) =>
      (BROWSER_TOOL_NAMES as readonly string[]).includes(t.name),
    );

    expect(browserTools.length).toBe(0);
  });
});
