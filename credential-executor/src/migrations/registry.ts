import { apiKeyToCredentialsMigration } from "./002-api-keys-to-credentials.js";
import { createLegacySecureKeyImportMigration } from "./003-import-legacy-secure-keys.js";
import { noOpMigration } from "./001-no-op.js";
import type { CesMigration } from "./types.js";

/**
 * Ordered list of unconditional CES data migrations.
 *
 * New migrations are appended to the end. Never reorder or remove entries —
 * the runner uses array position for ordering and the `id` field for
 * checkpoint tracking.
 */
export const CES_MIGRATIONS: CesMigration[] = [
  noOpMigration,
  apiKeyToCredentialsMigration,
];

/**
 * Managed-mode migrations can include platform-wired one-time recovery steps.
 * Keep the legacy import absent until the platform supplies the legacy mount
 * env var, so the checkpoint is not consumed before the old store is visible.
 */
export function getManagedCesMigrations(): CesMigration[] {
  const legacySecurityDir =
    process.env["CREDENTIAL_LEGACY_SECURITY_DIR"]?.trim() || "";
  if (!legacySecurityDir) return CES_MIGRATIONS;
  return [
    ...CES_MIGRATIONS,
    createLegacySecureKeyImportMigration(legacySecurityDir),
  ];
}
