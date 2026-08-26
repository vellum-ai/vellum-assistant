import { existsSync } from "node:fs";

import {
  StaticCredentialMetadataStore,
  credentialKey,
  type SecureKeyBackend,
} from "@vellumai/credential-storage";

import { getLogger } from "../logger.js";
import { getCesDataRoot } from "../paths.js";
import {
  CesCredentialRecordStore,
  getCredentialRecordsPath,
  resolveWorkspaceMetadataPath,
} from "../records/credential-record-store.js";
import type { CesMigration } from "./types.js";

const log = getLogger("ces-migrations");

/**
 * Copy workspace `metadata.json` catalog rows into the CES record store.
 *
 * CES does not delete the workspace file (the workspace volume is read-only
 * in managed mode). The assistant retires the file after it confirms CES
 * holds the records.
 */
export const importWorkspaceMetadataMigration: CesMigration = {
  id: "003-import-workspace-metadata",
  description:
    "Import workspace credential metadata.json into the CES record store",

  async run(_backend: SecureKeyBackend): Promise<void> {
    const workspaceDir = process.env["VELLUM_WORKSPACE_DIR"]?.trim();
    const metadataPath = resolveWorkspaceMetadataPath(workspaceDir);
    if (!metadataPath || !existsSync(metadataPath)) {
      log.info(
        "CES record import: no workspace metadata.json; skipping",
      );
      return;
    }

    const source = new StaticCredentialMetadataStore(metadataPath);
    const records = source.list();
    if (records.length === 0) {
      log.info("CES record import: workspace metadata.json has no rows");
      return;
    }

    const store = new CesCredentialRecordStore(
      getCredentialRecordsPath(getCesDataRoot()),
    );
    let imported = 0;
    let skipped = 0;
    for (const record of records) {
      const account = credentialKey(record.service, record.field);
      const existing = store.getByAccount(account);
      if (existing) {
        skipped += 1;
        continue;
      }
      const ok = store.setByAccount(account, {
        credentialId: record.credentialId,
        service: record.service,
        field: record.field,
        allowedTools: record.allowedTools,
        allowedDomains: record.allowedDomains,
        usageDescription: record.usageDescription,
        alias: record.alias,
        injectionTemplates: record.injectionTemplates,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      if (ok) {
        imported += 1;
      }
    }
    log.info(
      { imported, skipped, total: records.length },
      "CES record import from workspace metadata.json complete",
    );
  },

  async down(_backend: SecureKeyBackend): Promise<void> {
    // Forward-only: records remain in CES. The assistant owns file deletion.
  },
};
