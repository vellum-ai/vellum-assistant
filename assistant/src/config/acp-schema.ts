import { z } from "zod";

import { DEFAULT_ACP_AGENT_PROFILES } from "./acp-defaults.js";

export const AcpAgentConfigSchema = z
  .object({
    command: z
      .string()
      .optional()
      .describe(
        "Command to spawn the ACP agent process. Required unless the id has a bundled profile, whose command is inherited when this is unset",
      ),
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
        "Model sessions of this agent start on when the ask names none (an adapter-reported alias such as 'opus' or 'sonnet' for Claude, not an Assistant catalog id). Overrides the bundled profile's value; unset inherits it.",
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
      .superRefine((agents, ctx) => {
        for (const [id, agent] of Object.entries(agents)) {
          if (
            agent.command !== undefined ||
            Object.hasOwn(DEFAULT_ACP_AGENT_PROFILES, id)
          ) {
            continue;
          }
          ctx.addIssue({
            code: "custom",
            path: [id, "command"],
            message: `acp.agents.${id} needs a command: only the bundled ids (${Object.keys(DEFAULT_ACP_AGENT_PROFILES).join(", ")}) inherit one`,
          });
        }
      })
      .default({})
      .describe("Map of agent names to their configurations"),
  })
  .describe(
    "Agent Communication Protocol (ACP) — inter-agent communication and delegation",
  );

export type AcpConfig = z.infer<typeof AcpConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
