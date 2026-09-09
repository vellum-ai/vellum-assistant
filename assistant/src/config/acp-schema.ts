import { z } from "zod";

export const AcpAgentConfigSchema = z
  .object({
    command: z.string().describe("Command to spawn the ACP agent process"),
    args: z
      .array(z.string())
      .default([])
      .describe("Arguments passed to the agent command"),
    description: z
      .string()
      .optional()
      .describe("Human-readable description of what this agent does"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables set for the agent process"),
    model: z
      .string()
      .optional()
      .describe(
        "Default model for this agent, overriding acp.defaultModel. An adapter-reported alias.",
      ),
  })
  .describe("Configuration for an individual ACP agent");

export const AcpConfigSchema = z
  .object({
    maxConcurrentSessions: z
      .number()
      .int()
      .positive()
      .default(4)
      .describe(
        "Maximum number of ACP agent sessions that can run simultaneously",
      ),
    agents: z
      .record(z.string(), AcpAgentConfigSchema)
      .default({})
      .describe("Map of agent names to their configurations"),
    defaultModel: z
      .string()
      .optional()
      .describe(
        "Default model the coding agent starts with (an adapter-reported alias such as 'opus' or 'sonnet' for Claude, not an Assistant catalog id). Unset means the agent's own default.",
      ),
  })
  .describe(
    "Agent Communication Protocol (ACP) — inter-agent communication and delegation",
  );

export type AcpConfig = z.infer<typeof AcpConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
