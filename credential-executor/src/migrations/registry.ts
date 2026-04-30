import { noOpMigration } from "./001-no-op.js";
import type { CesMigration } from "./types.js";

/**
 * Ordered list of all CES data migrations.
 *
 * New migrations are appended to the end. Never reorder or remove entries —
 * the runner uses array position for ordering and the `id` field for
 * checkpoint tracking.
 */
export const CES_MIGRATIONS: CesMigration[] = [
  noOpMigration,
];
