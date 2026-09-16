import { z } from "zod";

import { MCP_GLOBAL_MAX_TOOLS } from "./mcp.js";

/** Highest workspace override accepted for the MCP global tool cap. */
export const MCP_GLOBAL_MAX_TOOLS_OVERRIDE_MAX = 500;

export const ToolsConfigSchema = z
  .object({
    exclude: z
      .array(z.string(), { error: "tools.exclude must be an array of strings" })
      .default([])
      .describe(
        "Tool names to suppress. Excluded tools are not sent to the LLM. Names match `ToolDefinition.name` exactly (e.g. `bash`, `mcp__server__tool`).",
      ),
    mcpGlobalMaxTools: z
      .number({ error: "tools.mcpGlobalMaxTools must be a number" })
      .int("tools.mcpGlobalMaxTools must be an integer")
      .min(1, "tools.mcpGlobalMaxTools must be >= 1")
      .max(
        MCP_GLOBAL_MAX_TOOLS_OVERRIDE_MAX,
        `tools.mcpGlobalMaxTools must be <= ${MCP_GLOBAL_MAX_TOOLS_OVERRIDE_MAX}`,
      )
      .optional()
      .describe(
        `Override the code-owned cap on MCP tools registered across every server. Omit to use the shipped default of ${MCP_GLOBAL_MAX_TOOLS}. Selection is a fair round-robin by server id.`,
      ),
  })
  .describe("Tool visibility configuration");

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
