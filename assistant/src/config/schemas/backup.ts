import { z } from "zod";

export const BackupDestinationSchema = z
  .object({
    path: z
      .string({ error: "backup.offsite.destinations[].path must be a string" })
      .describe("Absolute path to the offsite destination directory"),
    encrypt: z
      .boolean({
        error: "backup.offsite.destinations[].encrypt must be a boolean",
      })
      .default(true)
      .describe(
        "Encrypt backups written to this destination. Defaults to true; set to false only for destinations where the user trusts physical control (e.g. an external SSD).",
      ),
  })
  .describe("A single offsite backup destination");

export type BackupDestination = z.infer<typeof BackupDestinationSchema>;

export const BackupOffsiteConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "backup.offsite.enabled must be a boolean" })
      .default(true)
      .describe("Whether offsite backup is enabled"),
    destinations: z
      .array(BackupDestinationSchema)
      .nullable()
      .default(null)
      .describe(
        "Offsite destinations. null means use the default iCloud Drive destination with encryption on; an explicit array (including []) overrides the default.",
      ),
  })
  .describe("Offsite backup configuration");

export type BackupOffsiteConfig = z.infer<typeof BackupOffsiteConfigSchema>;

export const BackupConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "backup.enabled must be a boolean" })
      .default(false)
      .describe("Whether automated backups are enabled"),
    intervalHours: z
      .number({ error: "backup.intervalHours must be a number" })
      .int("backup.intervalHours must be an integer")
      .min(1, "backup.intervalHours must be >= 1")
      .max(168, "backup.intervalHours must be <= 168")
      .default(6)
      .describe("Interval between automated backups, in hours"),
    retention: z
      .number({ error: "backup.retention must be a number" })
      .int("backup.retention must be an integer")
      .min(1, "backup.retention must be >= 1")
      .max(100, "backup.retention must be <= 100")
      // Default retention is intentionally low (3) because each .vbundle
      // snapshot is a full copy — not incremental or deduplicated — so a
      // single snapshot can be several GB on a moderate workspace. With a 6h
      // interval, 3 snapshots covers ~18 hours of rollback, and that pool
      // doubles for each offsite destination. Users with plenty of disk can
      // raise this via `vellum backup enable --retention <n>`. See ATL-193.
      .default(3)
      .describe("Number of recent backups to retain"),
    offsite: BackupOffsiteConfigSchema.default(
      BackupOffsiteConfigSchema.parse({}),
    ),
    localDirectory: z
      .string({ error: "backup.localDirectory must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Directory for local backup snapshots. null means use the default workspace-adjacent location.",
      ),
  })
  .describe("Automated backup configuration");

export type BackupConfig = z.infer<typeof BackupConfigSchema>;
