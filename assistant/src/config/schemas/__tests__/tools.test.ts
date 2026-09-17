import { describe, expect, test } from "bun:test";

import { MCP_GLOBAL_MAX_TOOLS } from "../mcp.js";
import { ToolsConfigSchema } from "../tools.js";

describe("ToolsConfigSchema.mcpGlobalMaxTools", () => {
  test("omits the override so the shipped MCP cap remains in force", () => {
    const parsed = ToolsConfigSchema.parse({});
    expect(parsed.mcpGlobalMaxTools).toBeUndefined();
    expect(parsed.exclude).toEqual([]);
  });

  test("accepts a workspace override", () => {
    expect(
      ToolsConfigSchema.parse({ mcpGlobalMaxTools: 80 }).mcpGlobalMaxTools,
    ).toBe(80);
    expect(
      ToolsConfigSchema.parse({
        mcpGlobalMaxTools: MCP_GLOBAL_MAX_TOOLS,
      }).mcpGlobalMaxTools,
    ).toBe(MCP_GLOBAL_MAX_TOOLS);
    expect(
      ToolsConfigSchema.parse({ mcpGlobalMaxTools: 1000 }).mcpGlobalMaxTools,
    ).toBe(1000);
  });

  test("rejects zero and fractions", () => {
    expect(() => ToolsConfigSchema.parse({ mcpGlobalMaxTools: 0 })).toThrow();
    expect(() => ToolsConfigSchema.parse({ mcpGlobalMaxTools: 1.5 })).toThrow();
  });
});
