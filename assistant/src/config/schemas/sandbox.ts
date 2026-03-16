import { z } from "zod";

export const SandboxConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "sandbox.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether to run tool executions in a sandboxed environment for safety",
      ),
  })
  .describe("Sandbox configuration for isolating tool executions");

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
