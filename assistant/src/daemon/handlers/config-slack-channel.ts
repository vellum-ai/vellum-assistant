import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  ensureManualTokenConnection,
  removeManualTokenConnection,
  syncManualTokenConnection,
} from "../../oauth/manual-token-connection.js";
import { getConnectionByProvider } from "../../oauth/oauth-store.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { log as _log } from "./shared.js";

// -- Result type --

export interface SlackChannelConfigResult {
  success: boolean;
  hasBotToken: boolean;
  hasAppToken: boolean;
  hasUserToken: boolean;
  connected: boolean;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  botUsername?: string;
  error?: string;
  warning?: string;
}

// -- Helpers --

const SLACK_ALLOWED_DOMAINS = ["*.slack.com"];

const SLACK_INJECTION_TEMPLATES = [
  {
    hostPattern: "*.slack.com" as const,
    injectionType: "header" as const,
    headerName: "Authorization",
    valuePrefix: "Bearer ",
  },
];

/** Ensure the bot token credential has injection templates for the proxy. */
function ensureBotTokenInjectionTemplates(): void {
  upsertCredentialMetadata("slack_channel", "bot_token", {
    allowedDomains: SLACK_ALLOWED_DOMAINS,
    injectionTemplates: SLACK_INJECTION_TEMPLATES,
  });
}

/** Ensure the user token credential has injection templates for the proxy. */
function ensureUserTokenInjectionTemplates(): void {
  upsertCredentialMetadata("slack_channel", "user_token", {
    allowedDomains: SLACK_ALLOWED_DOMAINS,
    injectionTemplates: SLACK_INJECTION_TEMPLATES,
  });
}

/**
 * Whether a credential metadata record needs its Slack injection config
 * refreshed. True when templates are missing/empty or still carry the
 * pre-wildcard `slack.com` host pattern (which only matched the apex and
 * left `files.slack.com` file downloads unauthenticated), or when
 * `allowedDomains` hasn't been migrated to the wildcard form.
 */
function needsSlackInjectionRefresh(meta: {
  injectionTemplates?: { hostPattern: string }[];
  allowedDomains?: string[];
}): boolean {
  const templates = meta.injectionTemplates;
  if (!templates || templates.length === 0) return true;
  if (
    templates.some((tpl) =>
      SLACK_INJECTION_TEMPLATES.every((t) => t.hostPattern !== tpl.hostPattern),
    )
  ) {
    return true;
  }
  const domains = meta.allowedDomains ?? [];
  return (
    domains.length !== SLACK_ALLOWED_DOMAINS.length ||
    SLACK_ALLOWED_DOMAINS.some((d) => !domains.includes(d))
  );
}

/**
 * Backfill injection templates on the Slack credentials.
 * Called on daemon startup so existing credentials get proxy support and
 * any stale patterns (e.g. legacy `slack.com` exact match) are upgraded
 * to the current wildcard form without waiting for the user to re-open
 * the Slack config UI.
 */
export function backfillSlackInjectionTemplates(): void {
  const botMeta = getCredentialMetadata("slack_channel", "bot_token");
  if (botMeta && needsSlackInjectionRefresh(botMeta)) {
    ensureBotTokenInjectionTemplates();
  }
  const userMeta = getCredentialMetadata("slack_channel", "user_token");
  if (userMeta && needsSlackInjectionRefresh(userMeta)) {
    ensureUserTokenInjectionTemplates();
  }
}

// -- Business logic --

export async function getSlackChannelConfig(): Promise<SlackChannelConfigResult> {
  const { teamId, teamName, botUserId, botUsername } = getConfig().slack;
  const accountInfo = teamName
    ? `${teamName}${botUsername ? ` (@${botUsername})` : ""}`
    : undefined;
  await syncManualTokenConnection("slack_channel", accountInfo);

  const hasBotToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  ));
  const hasAppToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "app_token"),
  ));
  const hasUserToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "user_token"),
  ));
  const conn = getConnectionByProvider("slack_channel");
  const connected =
    !!(conn && conn.status === "active") && hasBotToken && hasAppToken;

  // Backfill injection templates for existing credentials that were stored
  // before proxy support was added. Safe to call repeatedly (upsert merges).
  if (hasBotToken) {
    ensureBotTokenInjectionTemplates();
  }
  if (hasUserToken) {
    ensureUserTokenInjectionTemplates();
  }

  return {
    success: true,
    hasBotToken,
    hasAppToken,
    hasUserToken,
    connected,
    ...(teamId ? { teamId } : {}),
    ...(teamName ? { teamName } : {}),
    ...(botUserId ? { botUserId } : {}),
    ...(botUsername ? { botUsername } : {}),
  };
}

/** Build an error-path result snapshot that reports the current credential state. */
async function currentErrorSnapshot(
  error: string,
): Promise<SlackChannelConfigResult> {
  const errHasBotToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  ));
  const errHasAppToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "app_token"),
  ));
  const errHasUserToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "user_token"),
  ));
  const errConn = getConnectionByProvider("slack_channel");
  return {
    success: false,
    hasBotToken: errHasBotToken,
    hasAppToken: errHasAppToken,
    hasUserToken: errHasUserToken,
    connected:
      !!(errConn && errConn.status === "active") &&
      errHasBotToken &&
      errHasAppToken,
    error,
  };
}

export async function setSlackChannelConfig(
  botToken?: string,
  appToken?: string,
  userToken?: string,
): Promise<SlackChannelConfigResult> {
  let metadata: {
    teamId?: string;
    teamName?: string;
    botUserId?: string;
    botUsername?: string;
  } = {};
  let warning: string | undefined;

  // Validate and store bot token
  if (botToken) {
    // Validate bot token by calling Slack auth.test
    try {
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}` },
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        team_id?: string;
        team?: string;
        user_id?: string;
        user?: string;
      };
      if (!data.ok) {
        return currentErrorSnapshot(
          `Slack API validation failed: ${data.error ?? "unknown error"}`,
        );
      }
      metadata = {
        teamId: data.team_id,
        teamName: data.team,
        botUserId: data.user_id,
        botUsername: data.user,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return currentErrorSnapshot(`Failed to validate bot token: ${message}`);
    }

    const stored = await setSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
      botToken,
    );
    if (!stored) {
      return currentErrorSnapshot(
        "Failed to store bot token in secure storage",
      );
    }

    ensureBotTokenInjectionTemplates();

    const raw = loadRawConfig();
    setNestedValue(raw, "slack.teamId", metadata.teamId ?? "");
    setNestedValue(raw, "slack.teamName", metadata.teamName ?? "");
    setNestedValue(raw, "slack.botUserId", metadata.botUserId ?? "");
    setNestedValue(raw, "slack.botUsername", metadata.botUsername ?? "");
    saveRawConfig(raw);
    invalidateConfigCache();

    // Cross-check existing user_token against the newly-stored bot_token's
    // workspace. A user_token persisted under a previous workspace (or whose
    // auth.test returns ok:false) must be cleared so reads and writes never
    // fan out across workspaces.
    //
    // IMPORTANT: we only clear on a definitive negative signal —
    // (a) auth.test returned ok:false, or
    // (b) auth.test returned ok:true with a team_id that differs from the new
    //     bot_token's team_id.
    //
    // Transient failures (network error, non-JSON response, JSON parse error)
    // must NOT wipe a still-valid user_token: for user-scope installs,
    // re-issuing can require admin approval. The adapter already tolerates a
    // stale token — it will surface on next real use, at which point the user
    // can re-run setup.
    const existingUserToken = await getSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
    );
    if (existingUserToken) {
      let shouldClear = false;
      let clearReason: string | undefined;
      try {
        const res = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { Authorization: `Bearer ${existingUserToken}` },
        });
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          team_id?: string;
        };
        if (!data.ok) {
          shouldClear = true;
          clearReason = "User token validation failed; it has been removed.";
        } else if (
          metadata.teamId &&
          data.team_id &&
          data.team_id !== metadata.teamId
        ) {
          shouldClear = true;
          clearReason = "User token from a different workspace was removed.";
        }
      } catch (err) {
        // Transient failure (DNS error, network blip, connection reset,
        // non-JSON response, JSON parse failure). Leave the user_token in
        // place — we have no definitive signal that it's invalid. Future
        // reads that actually hit Slack will fail naturally if the token is
        // actually bad, and the user can re-run setup then.
        const message = err instanceof Error ? err.message : String(err);
        _log.warn(
          { err: message },
          "Skipping user_token re-validation due to transient error; leaving existing user_token in place.",
        );
      }
      if (shouldClear) {
        const cleared = await clearSlackUserToken();
        if (!cleared.success) {
          const failMsg =
            "User token workspace mismatch detected but removal failed; please clear it manually.";
          warning = warning ? `${warning} ${failMsg}` : failMsg;
        } else if (clearReason) {
          warning = warning ? `${warning} ${clearReason}` : clearReason;
        }
      }
    }
  } else {
    // Use existing metadata from config if no new bot token provided
    const { teamId, teamName, botUserId, botUsername } = getConfig().slack;
    metadata = {
      ...(teamId ? { teamId } : {}),
      ...(teamName ? { teamName } : {}),
      ...(botUserId ? { botUserId } : {}),
      ...(botUsername ? { botUsername } : {}),
    };
  }

  // Validate and store app token
  if (appToken) {
    if (!appToken.startsWith("xapp-")) {
      return currentErrorSnapshot('Invalid app token: must start with "xapp-"');
    }

    const stored = await setSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
      appToken,
    );
    if (!stored) {
      return currentErrorSnapshot(
        "Failed to store app token in secure storage",
      );
    }

    upsertCredentialMetadata("slack_channel", "app_token", {});
  }

  // Validate and store user token (optional — grants read access to channels
  // the bot isn't a member of; writes always continue to go through the bot).
  if (userToken) {
    if (!userToken.startsWith("xoxp-")) {
      return currentErrorSnapshot(
        'Invalid user token: must start with "xoxp-"',
      );
    }

    let userTeamId: string | undefined;
    try {
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        team_id?: string;
      };
      if (!data.ok) {
        return currentErrorSnapshot(
          `Slack API validation failed: ${data.error ?? "unknown error"}`,
        );
      }
      userTeamId = data.team_id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return currentErrorSnapshot(`Failed to validate user token: ${message}`);
    }

    // Cross-check: if a bot token has already been configured, the user token
    // must be for the same workspace. If no bot token is configured yet, store
    // provisionally and skip the cross-check — the order of setup can vary.
    const existingBotTeamId = metadata.teamId;
    if (existingBotTeamId && userTeamId && existingBotTeamId !== userTeamId) {
      return currentErrorSnapshot(
        "User token is for a different workspace than the bot token",
      );
    }

    const stored = await setSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
      userToken,
    );
    if (!stored) {
      return currentErrorSnapshot(
        "Failed to store user token in secure storage",
      );
    }

    ensureUserTokenInjectionTemplates();
  }

  const hasBotToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  ));
  const hasAppToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "app_token"),
  ));
  const hasUserToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "user_token"),
  ));

  if (hasBotToken && !hasAppToken) {
    const msg =
      "Bot token stored but app token is missing — connection incomplete.";
    warning = warning ? `${warning} ${msg}` : msg;
  } else if (!hasBotToken && hasAppToken) {
    const msg =
      "App token stored but bot token is missing — connection incomplete.";
    warning = warning ? `${warning} ${msg}` : msg;
  }

  // Sync oauth_connection record so getConnectionByProvider("slack_channel")
  // reflects the current credential state.
  if (hasBotToken && hasAppToken) {
    ensureBotTokenInjectionTemplates();
    const accountInfo = metadata.teamName
      ? `${metadata.teamName}${metadata.botUsername ? ` (@${metadata.botUsername})` : ""}`
      : undefined;
    await ensureManualTokenConnection("slack_channel", accountInfo);
  } else {
    removeManualTokenConnection("slack_channel");
  }

  return {
    success: true,
    hasBotToken,
    hasAppToken,
    hasUserToken,
    connected: hasBotToken && hasAppToken,
    ...metadata,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Surgically remove the Slack user_token credential.
 *
 * Deletes only the user_token secure key and its credential metadata. Leaves
 * the bot_token, app_token, oauth_connection row, and Slack config metadata
 * untouched so the Socket Mode connection stays up. Returns a
 * `SlackChannelConfigResult` reflecting the remaining state. A `not-found`
 * delete outcome is reported as a failure to match the credential_store
 * delete semantics (callers and automation rely on missing-credential
 * detection).
 */
export async function clearSlackUserToken(): Promise<SlackChannelConfigResult> {
  const result = await deleteSecureKeyAsync(
    credentialKey("slack_channel", "user_token"),
  );

  if (result === "error" || result === "not-found") {
    const hasBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));
    const hasUserToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
    ));
    const conn = getConnectionByProvider("slack_channel");
    return {
      success: false,
      hasBotToken,
      hasAppToken,
      hasUserToken,
      connected:
        !!(conn && conn.status === "active") && hasBotToken && hasAppToken,
      error:
        result === "not-found"
          ? "Slack user token not found in secure storage"
          : "Failed to delete Slack user token from secure storage",
    };
  }

  deleteCredentialMetadata("slack_channel", "user_token");

  const hasBotToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  ));
  const hasAppToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "app_token"),
  ));
  const conn = getConnectionByProvider("slack_channel");
  const { teamId, teamName, botUserId, botUsername } = getConfig().slack;

  return {
    success: true,
    hasBotToken,
    hasAppToken,
    hasUserToken: false,
    connected:
      !!(conn && conn.status === "active") && hasBotToken && hasAppToken,
    ...(teamId ? { teamId } : {}),
    ...(teamName ? { teamName } : {}),
    ...(botUserId ? { botUserId } : {}),
    ...(botUsername ? { botUsername } : {}),
  };
}

export async function clearSlackChannelConfig(): Promise<SlackChannelConfigResult> {
  const r1 = await deleteSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  const r2 = await deleteSecureKeyAsync(
    credentialKey("slack_channel", "app_token"),
  );
  const r3 = await deleteSecureKeyAsync(
    credentialKey("slack_channel", "user_token"),
  );

  if (r1 === "error" || r2 === "error" || r3 === "error") {
    // Check each key individually so partial deletions report accurate status.
    const hasBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));
    const hasUserToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
    ));
    const conn = getConnectionByProvider("slack_channel");
    return {
      success: false,
      hasBotToken,
      hasAppToken,
      hasUserToken,
      connected:
        !!(conn && conn.status === "active") && hasBotToken && hasAppToken,
      error: "Failed to delete Slack channel credentials from secure storage",
    };
  }

  deleteCredentialMetadata("slack_channel", "bot_token");
  deleteCredentialMetadata("slack_channel", "app_token");
  deleteCredentialMetadata("slack_channel", "user_token");

  // Remove the oauth_connection row so getConnectionByProvider returns undefined.
  removeManualTokenConnection("slack_channel");

  const raw = loadRawConfig();
  setNestedValue(raw, "slack.teamId", "");
  setNestedValue(raw, "slack.teamName", "");
  setNestedValue(raw, "slack.botUserId", "");
  setNestedValue(raw, "slack.botUsername", "");
  saveRawConfig(raw);
  invalidateConfigCache();

  return {
    success: true,
    hasBotToken: false,
    hasAppToken: false,
    hasUserToken: false,
    connected: false,
  };
}
