/**
 * Startup tool payload characterization test — verifies that browser
 * operations are not exposed as tools in the startup registry.
 *
 * Browser automation is provided exclusively through the `assistant browser`
 * CLI commands. No `browser_*` tools exist in the tool registry.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  __resetRegistryForTesting,
  getAllToolDefinitions,
  getAllTools,
  initializeTools,
} from "../tools/registry.js";

afterAll(() => {
  __resetRegistryForTesting();
});

beforeAll(async () => {
  // Reset first to clear any tools registered via ESM side-effect
  // imports from other test files running in the same process.
  __resetRegistryForTesting();
  await initializeTools();
});

describe("startup tool payload — no browser tools", () => {
  test("no browser_* tools are present in the global registry at startup", () => {
    const registeredNames = getAllTools().map((t) => t.name);
    const browserTools = registeredNames.filter((n) =>
      n.startsWith("browser_"),
    );
    expect(browserTools).toHaveLength(0);
  });

  test("no browser_* tools appear in getAllToolDefinitions at startup", () => {
    const definitionNames = getAllToolDefinitions().map((d) => d.name);
    const browserDefs = definitionNames.filter((n) => n.startsWith("browser_"));
    expect(browserDefs).toHaveLength(0);
  });

  test("total tool definition count is within expected range", () => {
    const definitions = getAllToolDefinitions();
    // Startup has ~20 definitions after moving scaffold/settings/skill-management
    // tools to bundled skills.
    // Allow wider drift for unrelated tool additions while still failing if
    // a large batch of tools is reintroduced at startup.
    expect(definitions.length).toBeGreaterThanOrEqual(15);
    expect(definitions.length).toBeLessThanOrEqual(50);
  });

  test("serialized tool definitions payload is within expected size range", () => {
    const definitions = getAllToolDefinitions();
    const serialized = JSON.stringify(definitions);
    // Startup payload is ~22 000 chars.
    // Floor at 14 000 catches accidental wholesale removal; ceiling at 35 000
    // gives headroom while still catching unexpected tool leakage.
    expect(serialized.length).toBeGreaterThan(14_000);
    expect(serialized.length).toBeLessThan(35_000);
  });
});
