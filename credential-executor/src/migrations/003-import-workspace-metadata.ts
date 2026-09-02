import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { getLogger } from "../logger.js";
import { getCesDataRoot } from "../paths.js";
import {
  accountForRecord,
  CesMetadataStore,
  getMetadataPath,
} from "../records/metadata-store.js";
import type { CesMigration } from "./types.js";

function leftoverWorkspaceMetadataPath(
  workspaceDir: string | undefined,
): string | undefined {
  if (!workspaceDir || workspaceDir.trim() === "") {
    return undefined;
  }
  return join(workspaceDir, "data", "credentials", "metadata.json");
}

const log = getLogger("ces-migrations");

/**
 * Copy workspace `metadata.json` catalog rows into the CES metadata store.
 *
 * CES does not delete the workspace file (the workspace volume is
 * read-only in managed mode).
 */
export const importWorkspaceMetadataMigration: CesMigration = {
  id: "003-import-workspace-metadata",
  description:
    "Import workspace credential metadata.json into the CES metadata store",

  async run(_backend: SecureKeyBackend): Promise<void> {
    const workspaceDir = process.env["VELLUM_WORKSPACE_DIR"]?.trim();
    const leftoverPath = leftoverWorkspaceMetadataPath(workspaceDir);
    if (!leftoverPath || !existsSync(leftoverPath)) {
      log.info("CES metadata import: no workspace metadata.json; skipping");
      return;
    }

    const source = new CesMetadataStore(leftoverPath);
    const records = source.list();
    if (records.length === 0) {
      log.info("CES metadata import: workspace metadata.json has no rows");
      return;
    }

    const store = new CesMetadataStore(getMetadataPath(getCesDataRoot()));
    let imported = 0;
    let skipped = 0;
    for (const { record } of records) {
      const account = accountForRecord(record);
      const existing = store.getByAccount(account);
      if (existing) {
        skipped += 1;
        continue;
      }
      const ok = store.setByAccount(account, record);
      if (ok) {
        imported += 1;
      }
    }
    log.info(
      { imported, skipped, total: records.length },
      "CES metadata import from workspace metadata.json complete",
    );
  },

  async down(_backend: SecureKeyBackend): Promise<void> {
    // Forward-only: records remain in CES.
  },
};
