/**
 * Post-cutover characterization test — verifies that browser tools are NO
 * LONGER in the startup core tool payload.  They are now provided by the
 * bundled browser skill and only appear after skill_load activation.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import {
  initializeTools,
  getAllTools,
  getAllToolDefinitions,
  __resetRegistryForTesting,
} from '../tools/registry.js';
import { BROWSER_TOOL_NAMES } from './test-support/browser-skill-harness.js';

afterAll(() => { __resetRegistryForTesting(); });

async function captureStartupTools() {
  // Reset first to clear any browser tools registered via side-effect imports
  // from other test files running in the same process.
  __resetRegistryForTesting();
  await initializeTools();
  const tools = getAllTools();
  const definitions = getAllToolDefinitions();
  return { tools, definitions };
}

describe('browser skill cutover — startup tool payload', () => {
  test('no browser tools are present in the global registry at startup', async () => {
    const { tools } = await captureStartupTools();
    const registeredNames = new Set(tools.map((t) => t.name));

    for (const name of BROWSER_TOOL_NAMES) {
      expect(registeredNames.has(name)).toBe(false);
    }
  });

  test('no browser tools appear in getAllToolDefinitions at startup', async () => {
    const { definitions } = await captureStartupTools();
    const definitionNames = new Set(definitions.map((d) => d.name));

    for (const name of BROWSER_TOOL_NAMES) {
      expect(definitionNames.has(name)).toBe(false);
    }
  });

  test('total tool definition count reflects removal of 10 browser tools', async () => {
    const { definitions } = await captureStartupTools();
    // Keep broad bounds to avoid flapping on unrelated core-tool churn.
    expect(definitions.length).toBeGreaterThanOrEqual(28);
    expect(definitions.length).toBeLessThanOrEqual(40);
  });

  test('serialized tool definitions payload still exceeds a reasonable floor', async () => {
    const { definitions } = await captureStartupTools();
    const serialized = JSON.stringify(definitions);
    // Guard against accidental payload collapse while allowing healthy drift.
    expect(serialized.length).toBeGreaterThan(18_000);
    expect(serialized.length).toBeLessThan(30_000);
  });

  test('no browser-categorised tools remain in startup registry', async () => {
    const { tools } = await captureStartupTools();
    const browserTools = tools.filter((t) =>
      (BROWSER_TOOL_NAMES as readonly string[]).includes(t.name),
    );

    expect(browserTools.length).toBe(0);
  });
});
