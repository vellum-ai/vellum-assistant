import { z } from "zod";

export const UpdatesConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "updates.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the release update bulletin (UPDATES.md) is materialized into the workspace on daemon startup",
      ),
  })
  .describe("Release update bulletin configuration");

export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;
