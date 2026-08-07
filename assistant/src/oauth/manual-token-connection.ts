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
import { getTelegramBotUsername } from "../telegram/bot-username.js";
import { getLogger } from "../util/logger.js";
import {
  MANUAL_TOKEN_PROVIDERS,
  manualTokenProvider,
} from "./manual-token-providers.js";
import {
  createConnection,
  deleteConnection,
  getConnectionByProvider,
  updateConnection,
  upsertApp,
} from "./oauth-store.js";

const log = getLogger("manual-token-connection");

/** Sentinel client_id used for non-OAuth providers that don't have a real app. */
const MANUAL_TOKEN_CLIENT_ID = "manual-config";

type ResolvedAccountInfoSource = "provided" | "derived" | "none";

interface ResolvedAccountInfo {
  value?: string;
  source: ResolvedAccountInfoSource;
}

function resolveManualTokenAccountInfo(
  provider: string,
  accountInfo?: string,
): ResolvedAccountInfo {
  if (accountInfo !== undefined) {
    return { value: accountInfo, source: "provided" };
  }

  if (provider === "telegram") {
    const botUsername = getTelegramBotUsername();
    if (!botUsername) {
      return { source: "none" };
    }
    return {
      value: botUsername.startsWith("@") ? botUsername : `@${botUsername}`,
      source: "derived",
    };
  }

  return { source: "none" };
}

function accountInfoForManualTokenSync(
  provider: string,
  resolved: ResolvedAccountInfo,
): string | undefined {
  if (resolved.source !== "derived") {
    return resolved.value;
  }

  const existing = getConnectionByProvider(provider);
  if (existing?.accountInfo) {
    return undefined;
  }
  return resolved.value;
}

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
  if (!conn) {
    return;
  }
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
  const resolvedAccountInfo = resolveManualTokenAccountInfo(
    provider,
    accountInfo,
  );
  const accountInfoToStore = accountInfoForManualTokenSync(
    provider,
    resolvedAccountInfo,
  );

  const spec = manualTokenProvider(provider);
  if (!spec) {
    return;
  }

  // Every field must be present and readable. An unreachable backend is not
  // evidence a credential was removed, so the row is left as it stands rather
  // than being read as a disconnection.
  const results = await Promise.all(
    spec.fields.map((field) =>
      getSecureKeyResultAsync(credentialKey(provider, field)),
    ),
  );
  if (results.some((r) => r.unreachable)) {
    log.warn(
      `Skipping ${provider} manual-token reconciliation: credential backend unreachable`,
    );
    return;
  }

  if (results.every((r) => r.value)) {
    await ensureManualTokenConnection(provider, accountInfoToStore);
  } else {
    removeManualTokenConnection(provider);
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
  for (const provider of Object.keys(MANUAL_TOKEN_PROVIDERS)) {
    await syncManualTokenConnection(provider);
  }
}
