import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";

const KEYS_ENC_FILENAME = "keys.enc";

export type LegacySecureKeyImportSummary = {
  legacySecurityDir: string | null;
  discovered: number;
  imported: number;
  skippedExisting: number;
  unreadable: number;
  failed: number;
};

export async function importLegacySecureKeys(options: {
  legacySecurityDir?: string | null;
  targetBackend: SecureKeyBackend;
}): Promise<LegacySecureKeyImportSummary> {
  const legacySecurityDir = options.legacySecurityDir?.trim() || null;
  const emptySummary: LegacySecureKeyImportSummary = {
    legacySecurityDir,
    discovered: 0,
    imported: 0,
    skippedExisting: 0,
    unreadable: 0,
    failed: 0,
  };

  if (!legacySecurityDir) return emptySummary;
  if (!existsSync(join(legacySecurityDir, KEYS_ENC_FILENAME))) {
    return emptySummary;
  }

  const legacyBackend = createLocalSecureKeyBackend(legacySecurityDir, {
    securityDirOverride: legacySecurityDir,
  });

  const keys = await legacyBackend.list();
  const summary: LegacySecureKeyImportSummary = {
    ...emptySummary,
    discovered: keys.length,
  };

  for (const key of keys) {
    const existing = await options.targetBackend.get(key);
    if (existing !== undefined) {
      summary.skippedExisting++;
      continue;
    }

    const value = await legacyBackend.get(key);
    if (value === undefined) {
      summary.unreadable++;
      continue;
    }

    const stored = await options.targetBackend.set(key, value);
    if (stored) {
      summary.imported++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}
