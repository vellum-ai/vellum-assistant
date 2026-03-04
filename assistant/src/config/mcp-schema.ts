import { z } from "zod";

const McpStdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string({ error: "mcp transport command must be a string" }),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const McpSseTransportSchema = z.object({
  type: z.literal("sse"),
  url: z.string({ error: "mcp transport url must be a string" }),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpStreamableHttpTransportSchema = z.object({
  type: z.literal("streamable-http"),
  url: z.string({ error: "mcp transport url must be a string" }),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpTransportSchema = z.discriminatedUnion("type", [
  McpStdioTransportSchema,
  McpSseTransportSchema,
  McpStreamableHttpTransportSchema,
]);

export const McpServerConfigSchema = z.object({
  transport: McpTransportSchema,
  enabled: z
    .boolean({ error: "mcp server enabled must be a boolean" })
    .default(true),
  defaultRiskLevel: z
    .enum(["low", "medium", "high"], {
      error: "mcp server defaultRiskLevel must be one of: low, medium, high",
    })
    .default("high"),
  maxTools: z
    .number({ error: "mcp server maxTools must be a number" })
    .int()
    .positive()
    .default(20),
  allowedTools: z.array(z.string()).optional(),
  blockedTools: z.array(z.string()).optional(),
});

export const McpConfigSchema = z.object({
  servers: z
    .record(z.string(), McpServerConfigSchema)
    .default({} as Record<string, never>),
  globalMaxTools: z
    .number({ error: "mcp globalMaxTools must be a number" })
    .int()
    .positive()
    .default(50),
});

export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
