import { z } from "zod";

export const SandboxConfigSchema = z.object({
  enabled: z
    .boolean({ error: "sandbox.enabled must be a boolean" })
    .default(true),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
