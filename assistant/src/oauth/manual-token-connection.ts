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
import { getSecureKeyResultAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  createConnection,
  deleteConnection,
  getConnectionByProvider,
  updateConnection,
  upsertApp,
} from "./oauth-store.js";

// Re-export from the centralized resolver so existing callers that import
// from this module continue to work without changes.
export { manualTokenAccessCredentialKey } from "./credential-token-resolver.js";

const log = getLogger("manual-token-connection");

/** Sentinel client_id used for non-OAuth providers that don't have a real app. */
const MANUAL_TOKEN_CLIENT_ID = "manual-config";

/**
 * Ensure an active oauth_connection row exists for the given manual-token
 * provider. Creates the synthetic oauth_app row on first use.
 *
 * @param provider - The provider key (e.g. "slack_channel", "telegram")
 * @param accountInfo - Optional account info to store (e.g. team name, bot username)
 */
export async function ensureManualTokenConnection(
  provider: string,
  accountInfo?: string,
): Promise<void> {
  const existing = getConnectionByProvider(provider);
  if (existing) {
    // Update account info if provided
    if (accountInfo !== undefined) {
      updateConnection(existing.id, { accountInfo });
    }
    return;
  }

  // Create synthetic app + connection
  const app = await upsertApp(provider, MANUAL_TOKEN_CLIENT_ID);

  createConnection({
    oauthAppId: app.id,
    provider,
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
export function removeManualTokenConnection(provider: string): void {
  const conn = getConnectionByProvider(provider);
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
  provider: string,
  accountInfo?: string,
): Promise<void> {
  switch (provider) {
    case "telegram": {
      const botTokenResult = await getSecureKeyResultAsync(
        credentialKey("telegram", "bot_token"),
      );
      const webhookSecretResult = await getSecureKeyResultAsync(
        credentialKey("telegram", "webhook_secret"),
      );
      if (botTokenResult.unreachable || webhookSecretResult.unreachable) {
        log.warn(
          "Skipping telegram manual-token reconciliation — credential backend unreachable",
        );
        return;
      }
      if (botTokenResult.value && webhookSecretResult.value) {
        await ensureManualTokenConnection(provider, accountInfo);
      } else {
        removeManualTokenConnection(provider);
      }
      return;
    }

    case "slack_channel": {
      const botTokenResult = await getSecureKeyResultAsync(
        credentialKey("slack_channel", "bot_token"),
      );
      const appTokenResult = await getSecureKeyResultAsync(
        credentialKey("slack_channel", "app_token"),
      );
      if (botTokenResult.unreachable || appTokenResult.unreachable) {
        log.warn(
          "Skipping slack_channel manual-token reconciliation — credential backend unreachable",
        );
        return;
      }
      if (botTokenResult.value && appTokenResult.value) {
        await ensureManualTokenConnection(provider, accountInfo);
      } else {
        removeManualTokenConnection(provider);
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
