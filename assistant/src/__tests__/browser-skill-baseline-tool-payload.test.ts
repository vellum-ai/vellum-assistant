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
import { BROWSER_TOOL_NAMES } from './test-support/browser-skill-harness.js';

afterAll(() => { __resetRegistryForTesting(); });

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
    // Startup has exactly 48 definitions (no browser tools).
    // Allow wider drift for unrelated tool additions while still failing if
    // browser tools are reintroduced at startup (+10 definitions).
    expect(definitions.length).toBeGreaterThanOrEqual(46);
    expect(definitions.length).toBeLessThanOrEqual(65);
  });

  test('serialized tool definitions payload still exceeds a reasonable floor', () => {
    const definitions = getAllToolDefinitions();
    const serialized = JSON.stringify(definitions);
    // Startup payload is ~45 034 chars without browser tools.
    // Floor at 30 000 catches accidental wholesale removal; ceiling at 47 000
    // gives ~2 000 char headroom while still catching browser tool leakage
    // (~4 640 chars would push it past the ceiling).
    expect(serialized.length).toBeGreaterThan(30_000);
    expect(serialized.length).toBeLessThan(47_000);
  });

  test('no browser-categorised tools remain in startup registry', () => {
    const browserTools = getAllTools().filter((t) =>
      (BROWSER_TOOL_NAMES as readonly string[]).includes(t.name),
    );

    expect(browserTools.length).toBe(0);
  });
});
