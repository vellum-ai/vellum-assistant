import type { WorkspaceMigration } from "./types.js";

/**
 * Originally seeded default inference profiles into config.json.
 * Profile seeding is now handled declaratively by the workspace config
 * layer, so this migration is a no-op. The entry is kept so the
 * migration ID is not reused and existing checkpoints remain valid.
 */
export const seedDefaultInferenceProfiles052: WorkspaceMigration = {
  id: "052-seed-default-inference-profiles",
  description:
    "Seed default inference profiles (quality-optimized, balanced, cost-optimized) and activeProfile",
  run(): void {
    return;
  },
  down(): void {
    // Forward-only: removing the seeded profiles would break any user
    // configs that reference them via `activeProfile` or per-call-site
    // `profile`.
  },
};
