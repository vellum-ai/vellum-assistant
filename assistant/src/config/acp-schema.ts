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
  })
  .describe("Configuration for an individual ACP agent");

export const AcpConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Whether the Agent Communication Protocol (ACP) system is enabled",
      ),
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
  })
  .describe(
    "Agent Communication Protocol (ACP) — enables inter-agent communication and delegation",
  );

export type AcpConfig = z.infer<typeof AcpConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
