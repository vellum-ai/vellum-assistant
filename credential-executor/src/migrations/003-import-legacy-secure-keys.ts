import type { CesMigration } from "./types.js";

import { importLegacySecureKeys } from "../legacy-secure-key-import.js";
import { getLogger } from "../logger.js";
import { apiKeyToCredentialsMigration } from "./002-api-keys-to-credentials.js";

const log = getLogger("ces-migrations");

export function createLegacySecureKeyImportMigration(
  legacySecurityDir: string,
): CesMigration {
  return {
    id: "003-import-legacy-secure-keys",
    description: "Import legacy BYOK credentials into the CES store",

    async run(backend): Promise<void> {
      const summary = await importLegacySecureKeys({
        legacySecurityDir,
        targetBackend: backend,
      });

      if (
        summary.discovered > 0 ||
        summary.imported > 0 ||
        summary.unreadable > 0 ||
        summary.failed > 0
      ) {
        log.info(
          {
            discovered: summary.discovered,
            imported: summary.imported,
            skippedExisting: summary.skippedExisting,
            unreadable: summary.unreadable,
            failed: summary.failed,
          },
          "CES migration: checked legacy secure key store",
        );
      }

      if (summary.discovered > 0) {
        await apiKeyToCredentialsMigration.run(backend);
      }
    },

    async down(): Promise<void> {
      // Forward-only. Imported credentials may have been edited or deleted
      // after migration, so rollback cannot distinguish imported values from
      // intentional current CES state.
    },
  };
}
