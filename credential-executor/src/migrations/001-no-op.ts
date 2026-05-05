import type { CesMigration } from "./types.js";

/**
 * No-op foundation migration.
 *
 * Establishes the CES migration system and seeds the checkpoint file for
 * all existing installations. The next real migration (API key → credential
 * key rekeying) will follow this one.
 */
export const noOpMigration: CesMigration = {
  id: "001-no-op",
  description: "Seed CES migration checkpoint (no-op foundation)",
  run(_backend): void {
    // Intentionally empty — seeds the checkpoint file for existing installs.
  },
  down(_backend): void {
    // Intentionally empty — nothing to reverse.
  },
};
