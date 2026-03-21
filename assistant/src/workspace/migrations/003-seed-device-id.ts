import type { WorkspaceMigration } from "./types.js";

export const seedDeviceIdMigration: WorkspaceMigration = {
  id: "003-seed-device-id",
  description:
    "Seed device.json deviceId from the most recent lockfile installationId for continuity",
  // This migration previously read the lockfile to seed device.json.
  // It has already run for all existing installs and is now a no-op.
  // New installs generate a fresh deviceId via getDeviceId().
  run(): void {},
};
