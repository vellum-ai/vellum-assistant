import { z } from "zod";

export const MigrationsWorkerConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "migrations.worker.enabled must be a boolean" })
      .default(false)
      .describe(
        "Enable the async migration worker. While false, migrations that are too expensive to run inside the synchronous startup migration runner skip their work and pass, deferring until the async runner is in place.",
      ),
  })
  .describe("Async migration worker configuration");

export const MigrationsConfigSchema = z
  .object({
    worker: MigrationsWorkerConfigSchema.default(
      MigrationsWorkerConfigSchema.parse({}),
    ),
  })
  .describe("Workspace/database migration configuration");

export type MigrationsWorkerConfig = z.infer<
  typeof MigrationsWorkerConfigSchema
>;
export type MigrationsConfig = z.infer<typeof MigrationsConfigSchema>;
