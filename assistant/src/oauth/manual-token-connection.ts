/**
 * Helpers for managing oauth_connection records for non-OAuth (manual-token)
 * providers like slack_channel and telegram.
 *
 * These providers store credentials via the credential store (setSecureKeyAsync)
 * but also maintain an oauth_connection row so that getConnectionByProvider()
 * can be used as the single source of truth for connection status across the
 * codebase.
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import {
  createConnection,
  deleteConnection,
  getConnectionByProvider,
  updateConnection,
  upsertApp,
} from "./oauth-store.js";

/** Sentinel client_id used for non-OAuth providers that don't have a real app. */
const MANUAL_TOKEN_CLIENT_ID = "manual-config";

/**
 * Ensure an active oauth_connection row exists for the given manual-token
 * provider. Creates the synthetic oauth_app row on first use.
 *
 * @param providerKey - The provider key (e.g. "slack_channel", "telegram")
 * @param accountInfo - Optional account info to store (e.g. team name, bot username)
 */
export async function ensureManualTokenConnection(
  providerKey: string,
  accountInfo?: string,
): Promise<void> {
  const existing = getConnectionByProvider(providerKey);
  if (existing) {
    // Update account info if provided
    if (accountInfo !== undefined) {
      updateConnection(existing.id, { accountInfo });
    }
    return;
  }

  // Create synthetic app + connection
  const app = await upsertApp(providerKey, MANUAL_TOKEN_CLIENT_ID);

  createConnection({
    oauthAppId: app.id,
    providerKey,
    accountInfo,
    grantedScopes: [],
    hasRefreshToken: false,
  });
}

/**
 * Remove the oauth_connection row for a manual-token provider.
 *
 * Note: This only removes the oauth_connection row. The caller is still
 * responsible for deleting the stored credentials separately.
 */
export function removeManualTokenConnection(providerKey: string): void {
  const conn = getConnectionByProvider(providerKey);
  if (!conn) return;
  deleteConnection(conn.id);
}

/**
 * Reconcile the synthetic oauth_connection row for a manual-token provider
 * with whatever credentials are currently present in secure storage.
 *
 * This lets generic credential entry paths (chat setup, CLI, secure prompt)
 * keep connection status in sync without duplicating per-provider rules.
 */
export async function syncManualTokenConnection(
  providerKey: string,
  accountInfo?: string,
): Promise<void> {
  switch (providerKey) {
    case "telegram": {
      const hasBotToken = !!(await getSecureKeyAsync(
        credentialKey("telegram", "bot_token"),
      ));
      const hasWebhookSecret = !!(await getSecureKeyAsync(
        credentialKey("telegram", "webhook_secret"),
      ));
      if (hasBotToken && hasWebhookSecret) {
        await ensureManualTokenConnection(providerKey, accountInfo);
      } else {
        removeManualTokenConnection(providerKey);
      }
      return;
    }

    case "slack_channel": {
      const hasBotToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
      ));
      const hasAppToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
      ));
      if (hasBotToken && hasAppToken) {
        await ensureManualTokenConnection(providerKey, accountInfo);
      } else {
        removeManualTokenConnection(providerKey);
      }
      return;
    }

    default:
      return;
  }
}

/**
 * Backfill oauth_connection rows for manual-token providers that already
 * have valid stored credentials but are missing connection records.
 *
 * This handles the upgrade path from installations that stored credentials
 * before the oauth_connection migration. Without this, existing Telegram
 * and Slack channel integrations would appear disconnected after upgrading
 * until the user reconfigures them.
 *
 * Safe to call on every startup — skips providers that already have a
 * connection row.
 */
export async function backfillManualTokenConnections(): Promise<void> {
  await syncManualTokenConnection("telegram");
  await syncManualTokenConnection("slack_channel");
}
