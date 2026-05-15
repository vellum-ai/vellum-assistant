import { z } from "zod";

export const ToolsConfigSchema = z
  .object({
    exclude: z
      .array(z.string(), { error: "tools.exclude must be an array of strings" })
      .default([])
      .describe(
        "Tool names to suppress. Excluded tools are not sent to the LLM. Names match `ToolDefinition.name` exactly (e.g. `bash`, `mcp__server__tool`).",
      ),
  })
  .describe("Tool visibility configuration");

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
