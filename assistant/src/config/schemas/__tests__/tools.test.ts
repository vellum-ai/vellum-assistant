import { describe, expect, test } from "bun:test";

import { MCP_GLOBAL_MAX_TOOLS } from "../mcp.js";
import {
  MCP_GLOBAL_MAX_TOOLS_OVERRIDE_MAX,
  ToolsConfigSchema,
} from "../tools.js";

describe("ToolsConfigSchema.mcpGlobalMaxTools", () => {
  test("omits the override so the shipped MCP cap remains in force", () => {
    const parsed = ToolsConfigSchema.parse({});
    expect(parsed.mcpGlobalMaxTools).toBeUndefined();
    expect(parsed.exclude).toEqual([]);
  });

  test("accepts a workspace override in the allowed range", () => {
    expect(
      ToolsConfigSchema.parse({ mcpGlobalMaxTools: 80 }).mcpGlobalMaxTools,
    ).toBe(80);
    expect(
      ToolsConfigSchema.parse({
        mcpGlobalMaxTools: MCP_GLOBAL_MAX_TOOLS,
      }).mcpGlobalMaxTools,
    ).toBe(MCP_GLOBAL_MAX_TOOLS);
  });

  test("rejects zero, fractions, and values above the ceiling", () => {
    expect(() => ToolsConfigSchema.parse({ mcpGlobalMaxTools: 0 })).toThrow();
    expect(() => ToolsConfigSchema.parse({ mcpGlobalMaxTools: 1.5 })).toThrow();
    expect(() =>
      ToolsConfigSchema.parse({
        mcpGlobalMaxTools: MCP_GLOBAL_MAX_TOOLS_OVERRIDE_MAX + 1,
      }),
    ).toThrow();
  });
});
