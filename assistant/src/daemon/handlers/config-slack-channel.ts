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
  connected: boolean;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  botUsername?: string;
  error?: string;
  warning?: string;
}

// -- Helpers --

const SLACK_INJECTION_TEMPLATES = [
  {
    hostPattern: "slack.com" as const,
    injectionType: "header" as const,
    headerName: "Authorization",
    valuePrefix: "Bearer ",
  },
];

/** Ensure the bot token credential has injection templates for the proxy. */
function ensureBotTokenInjectionTemplates(): void {
  upsertCredentialMetadata("slack_channel", "bot_token", {
    allowedDomains: ["slack.com"],
    injectionTemplates: SLACK_INJECTION_TEMPLATES,
  });
}

/**
 * Backfill injection templates on the Slack bot token credential.
 * Called on daemon startup so existing credentials get proxy support.
 */
export function backfillSlackInjectionTemplates(): void {
  const meta = getCredentialMetadata("slack_channel", "bot_token");
  if (
    meta &&
    (!meta.injectionTemplates || meta.injectionTemplates.length === 0)
  ) {
    ensureBotTokenInjectionTemplates();
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
  const conn = getConnectionByProvider("slack_channel");
  const connected =
    !!(conn && conn.status === "active") && hasBotToken && hasAppToken;

  // Backfill injection templates for existing credentials that were stored
  // before proxy support was added. Safe to call repeatedly (upsert merges).
  if (hasBotToken) {
    ensureBotTokenInjectionTemplates();
  }

  return {
    success: true,
    hasBotToken,
    hasAppToken,
    connected,
    ...(teamId ? { teamId } : {}),
    ...(teamName ? { teamName } : {}),
    ...(botUserId ? { botUserId } : {}),
    ...(botUsername ? { botUsername } : {}),
  };
}

export async function setSlackChannelConfig(
  botToken?: string,
  appToken?: string,
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
        const errHasBotToken = !!(await getSecureKeyAsync(
          credentialKey("slack_channel", "bot_token"),
        ));
        const errHasAppToken = !!(await getSecureKeyAsync(
          credentialKey("slack_channel", "app_token"),
        ));
        const errConn = getConnectionByProvider("slack_channel");
        return {
          success: false,
          hasBotToken: errHasBotToken,
          hasAppToken: errHasAppToken,
          connected:
            !!(errConn && errConn.status === "active") &&
            errHasBotToken &&
            errHasAppToken,
          error: `Slack API validation failed: ${
            data.error ?? "unknown error"
          }`,
        };
      }
      metadata = {
        teamId: data.team_id,
        teamName: data.team,
        botUserId: data.user_id,
        botUsername: data.user,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errHasBotToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
      ));
      const errHasAppToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
      ));
      const errConn = getConnectionByProvider("slack_channel");
      return {
        success: false,
        hasBotToken: errHasBotToken,
        hasAppToken: errHasAppToken,
        connected:
          !!(errConn && errConn.status === "active") &&
          errHasBotToken &&
          errHasAppToken,
        error: `Failed to validate bot token: ${message}`,
      };
    }

    const stored = await setSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
      botToken,
    );
    if (!stored) {
      const errHasBotToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
      ));
      const errHasAppToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
      ));
      const errConn = getConnectionByProvider("slack_channel");
      return {
        success: false,
        hasBotToken: errHasBotToken,
        hasAppToken: errHasAppToken,
        connected:
          !!(errConn && errConn.status === "active") &&
          errHasBotToken &&
          errHasAppToken,
        error: "Failed to store bot token in secure storage",
      };
    }

    ensureBotTokenInjectionTemplates();

    const raw = loadRawConfig();
    setNestedValue(raw, "slack.teamId", metadata.teamId ?? "");
    setNestedValue(raw, "slack.teamName", metadata.teamName ?? "");
    setNestedValue(raw, "slack.botUserId", metadata.botUserId ?? "");
    setNestedValue(raw, "slack.botUsername", metadata.botUsername ?? "");
    saveRawConfig(raw);
    invalidateConfigCache();
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
      const errHasBotToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
      ));
      const errHasAppToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
      ));
      const errConn = getConnectionByProvider("slack_channel");
      return {
        success: false,
        hasBotToken: errHasBotToken,
        hasAppToken: errHasAppToken,
        connected:
          !!(errConn && errConn.status === "active") &&
          errHasBotToken &&
          errHasAppToken,
        error: 'Invalid app token: must start with "xapp-"',
      };
    }

    const stored = await setSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
      appToken,
    );
    if (!stored) {
      const errHasBotToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
      ));
      const errHasAppToken = !!(await getSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
      ));
      const errConn = getConnectionByProvider("slack_channel");
      return {
        success: false,
        hasBotToken: errHasBotToken,
        hasAppToken: errHasAppToken,
        connected:
          !!(errConn && errConn.status === "active") &&
          errHasBotToken &&
          errHasAppToken,
        error: "Failed to store app token in secure storage",
      };
    }

    upsertCredentialMetadata("slack_channel", "app_token", {});
  }

  const hasBotToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  ));
  const hasAppToken = !!(await getSecureKeyAsync(
    credentialKey("slack_channel", "app_token"),
  ));

  if (hasBotToken && !hasAppToken) {
    warning =
      "Bot token stored but app token is missing — connection incomplete.";
  } else if (!hasBotToken && hasAppToken) {
    warning =
      "App token stored but bot token is missing — connection incomplete.";
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
    connected: hasBotToken && hasAppToken,
    ...metadata,
    ...(warning ? { warning } : {}),
  };
}

export async function clearSlackChannelConfig(): Promise<SlackChannelConfigResult> {
  const r1 = await deleteSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  const r2 = await deleteSecureKeyAsync(
    credentialKey("slack_channel", "app_token"),
  );

  if (r1 === "error" || r2 === "error") {
    // Check each key individually so partial deletions report accurate status.
    const hasBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));
    const conn = getConnectionByProvider("slack_channel");
    return {
      success: false,
      hasBotToken,
      hasAppToken,
      connected:
        !!(conn && conn.status === "active") && hasBotToken && hasAppToken,
      error: "Failed to delete Slack channel credentials from secure storage",
    };
  }

  deleteCredentialMetadata("slack_channel", "bot_token");
  deleteCredentialMetadata("slack_channel", "app_token");

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
    connected: false,
  };
}
