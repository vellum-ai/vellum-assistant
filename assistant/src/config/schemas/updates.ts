import { z } from "zod";

export const UpdatesConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "updates.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether to dispatch a background conversation when ~/.vellum/workspace/UPDATES.md has unprocessed content. When false, release-update bulletins are written by migrations but never processed by the agent.",
      ),
  })
  .describe("Release update bulletin configuration");

export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;
