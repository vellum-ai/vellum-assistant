import { credentialKey } from "../../security/credential-key.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");
const CREDENTIAL_PREFIX = "credential/";

/**
 * Re-key compound credential storage keys from the old indexOf-based split
 * to the new lastIndexOf-based split.
 *
 * The old code split "integration:google:access_token" at the first colon:
 *   service = "integration", field = "google:access_token"
 *   → key = "credential/integration/google:access_token"
 *
 * The new code splits at the last colon:
 *   service = "integration:google", field = "access_token"
 *   → key = "credential/integration:google/access_token"
 *
 * Detection heuristic: if the field portion of a stored key contains a colon,
 * it was stored with the old indexOf logic and needs re-keying. Simple
 * service:field names (single colon) produce the same key with both methods
 * and don't need migration.
 */
export const rekeyCompoundCredentialKeysMigration: WorkspaceMigration = {
  id: "018-rekey-compound-credential-keys",
  description:
    "Re-key compound credential keys from indexOf to lastIndexOf split format",

  async run(_workspaceDir: string): Promise<void> {
    const {
      listSecureKeysAsync,
      getSecureKeyAsync,
      setSecureKeyAsync,
      deleteSecureKeyAsync,
    } = await import("../../security/secure-keys.js");

    const { accounts, unreachable } = await listSecureKeysAsync();
    if (unreachable) {
      throw new Error(
        "Credential store unreachable — migration will be retried on next startup",
      );
    }

    let migratedCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      if (!account.startsWith(CREDENTIAL_PREFIX)) continue;

      const rest = account.slice(CREDENTIAL_PREFIX.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx < 1 || slashIdx >= rest.length - 1) continue;

      const oldService = rest.slice(0, slashIdx);
      const oldField = rest.slice(slashIdx + 1);

      // Only migrate keys where the field contains a colon — these were
      // stored using the old indexOf(":") split and need re-keying.
      if (!oldField.includes(":")) continue;

      // Reconstruct the original "service:field" name and re-split with lastIndexOf
      const originalName = `${oldService}:${oldField}`;
      const lastColonIdx = originalName.lastIndexOf(":");
      const newService = originalName.slice(0, lastColonIdx);
      const newField = originalName.slice(lastColonIdx + 1);
      const newKey = credentialKey(newService, newField);

      // Skip if the key format didn't actually change
      if (account === newKey) continue;

      // Skip if the new key already exists (idempotent — may have been
      // partially migrated or the user already stored under the new format)
      const existingNewValue = await getSecureKeyAsync(newKey);
      if (existingNewValue !== undefined) {
        // New key exists — just clean up the old orphaned key
        await deleteSecureKeyAsync(account);
        log.info(
          { oldKey: account, newKey },
          "Deleted orphaned old-format credential key (new key already exists)",
        );
        migratedCount++;
        continue;
      }

      const value = await getSecureKeyAsync(account);
      if (value === undefined) continue;

      // Write new key first, then delete old key (crash-safe order)
      const stored = await setSecureKeyAsync(newKey, value);
      if (!stored) {
        log.warn(
          { oldKey: account, newKey },
          "Failed to write re-keyed credential — skipping",
        );
        failedCount++;
        continue;
      }

      await deleteSecureKeyAsync(account);
      migratedCount++;
      log.info({ oldKey: account, newKey }, "Re-keyed compound credential");
    }

    if (migratedCount > 0 || failedCount > 0) {
      log.info(
        { migratedCount, failedCount },
        "Compound credential key migration complete",
      );
    }
  },

  async down(_workspaceDir: string): Promise<void> {
    // Reverse: re-key from lastIndexOf format back to indexOf format.
    // Keys where the service contains ":" were migrated from old format.
    const {
      listSecureKeysAsync,
      getSecureKeyAsync,
      setSecureKeyAsync,
      deleteSecureKeyAsync,
    } = await import("../../security/secure-keys.js");

    const { accounts, unreachable } = await listSecureKeysAsync();
    if (unreachable) {
      throw new Error(
        "Credential store unreachable — rollback will be retried on next startup",
      );
    }

    let rolledBackCount = 0;
    let failedCount = 0;

    for (const account of accounts) {
      if (!account.startsWith(CREDENTIAL_PREFIX)) continue;

      const rest = account.slice(CREDENTIAL_PREFIX.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx < 1 || slashIdx >= rest.length - 1) continue;

      const service = rest.slice(0, slashIdx);
      const field = rest.slice(slashIdx + 1);

      // Only rollback keys where the service contains ":" — these are in
      // the new lastIndexOf format and need reverting to indexOf format.
      if (!service.includes(":")) continue;

      // Reconstruct the original name and re-split with indexOf (old format)
      const originalName = `${service}:${field}`;
      const firstColonIdx = originalName.indexOf(":");
      const oldService = originalName.slice(0, firstColonIdx);
      const oldField = originalName.slice(firstColonIdx + 1);
      const oldKey = credentialKey(oldService, oldField);

      if (account === oldKey) continue;

      const value = await getSecureKeyAsync(account);
      if (value === undefined) continue;

      const stored = await setSecureKeyAsync(oldKey, value);
      if (!stored) {
        log.warn(
          { newKey: account, oldKey },
          "Failed to rollback re-keyed credential — skipping",
        );
        failedCount++;
        continue;
      }

      await deleteSecureKeyAsync(account);
      rolledBackCount++;
      log.info(
        { newKey: account, oldKey },
        "Rolled back compound credential key",
      );
    }

    if (rolledBackCount > 0 || failedCount > 0) {
      log.info(
        { rolledBackCount, failedCount },
        "Compound credential key rollback complete",
      );
    }
  },
};
