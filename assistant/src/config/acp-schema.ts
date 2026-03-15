import { z } from "zod";

export const AcpAgentConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const AcpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxConcurrentSessions: z.number().int().positive().default(4),
  agents: z.record(z.string(), AcpAgentConfigSchema).default({}),
});

export type AcpConfig = z.infer<typeof AcpConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
