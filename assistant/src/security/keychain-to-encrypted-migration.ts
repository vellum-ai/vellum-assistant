/**
 * One-time migration: copies existing macOS keychain items into the
 * encrypted file store so the daemon can stop using the keychain CLI.
 * Runs once on first startup after the change, then skips via a marker key.
 */

import { API_KEY_PROVIDERS } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { isMacOS } from "../util/platform.js";
import * as encryptedStore from "./encrypted-store.js";
import * as keychain from "./keychain.js";

const log = getLogger("keychain-migration");
const MIGRATION_MARKER = "keychain-to-encrypted-migrated";

/** Known credential keys that the daemon may have stored in the keychain. */
const CREDENTIAL_KEYS = [
  "credential:twilio:account_sid",
  "credential:twilio:auth_token",
  "credential:twilio:phone_number",
  "credential:twilio:user_phone_number",
  "credential:telegram:bot_token",
  "credential:telegram:webhook_secret",
  "credential:elevenlabs:api_key",
  "credential:integration:gmail:access_token",
  "credential:integration:gmail:refresh_token",
  "credential:integration:twitter:access_token",
  "credential:integration:twitter:refresh_token",
  "credential:integration:slack:access_token",
  "credential:integration:slack:refresh_token",
];

export function migrateKeychainToEncrypted(): void {
  if (!isMacOS()) return;
  if (encryptedStore.getKey(MIGRATION_MARKER) === "true") return;

  let migrated = 0;
  let hadErrors = false;
  const allKeys = [...API_KEY_PROVIDERS, ...CREDENTIAL_KEYS];

  for (const account of allKeys) {
    try {
      const value = keychain.getKey(account);
      if (value != null && !encryptedStore.getKey(account)) {
        encryptedStore.setKey(account, value);
        migrated++;
      }
    } catch {
      hadErrors = true;
      log.warn({ account }, "Keychain read failed during migration");
    }
  }

  if (hadErrors) {
    log.warn("Skipping migration marker — will retry on next startup");
    return;
  }

  encryptedStore.setKey(MIGRATION_MARKER, "true");
  if (migrated > 0) {
    log.info(
      { count: migrated },
      "Migrated keys from keychain to encrypted store",
    );
  }
}
