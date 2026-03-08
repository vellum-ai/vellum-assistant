import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  deleteSecureKeyAsync,
  getSecureKey,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
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

// -- Business logic --

export function getSlackChannelConfig(): SlackChannelConfigResult {
  const hasBotToken = !!getSecureKey("credential:slack_channel:bot_token");
  const hasAppToken = !!getSecureKey("credential:slack_channel:app_token");
  const { teamId, teamName, botUserId, botUsername } = getConfig().slack;
  return {
    success: true,
    hasBotToken,
    hasAppToken,
    connected: hasBotToken && hasAppToken,
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
        const storedBotToken = !!getSecureKey(
          "credential:slack_channel:bot_token",
        );
        const storedAppToken = !!getSecureKey(
          "credential:slack_channel:app_token",
        );
        return {
          success: false,
          hasBotToken: storedBotToken,
          hasAppToken: storedAppToken,
          connected: storedBotToken && storedAppToken,
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
      const storedBotToken = !!getSecureKey(
        "credential:slack_channel:bot_token",
      );
      const storedAppToken = !!getSecureKey(
        "credential:slack_channel:app_token",
      );
      return {
        success: false,
        hasBotToken: storedBotToken,
        hasAppToken: storedAppToken,
        connected: storedBotToken && storedAppToken,
        error: `Failed to validate bot token: ${message}`,
      };
    }

    const stored = await setSecureKeyAsync(
      "credential:slack_channel:bot_token",
      botToken,
    );
    if (!stored) {
      const storedBotToken = !!getSecureKey(
        "credential:slack_channel:bot_token",
      );
      const storedAppToken = !!getSecureKey(
        "credential:slack_channel:app_token",
      );
      return {
        success: false,
        hasBotToken: storedBotToken,
        hasAppToken: storedAppToken,
        connected: storedBotToken && storedAppToken,
        error: "Failed to store bot token in secure storage",
      };
    }

    upsertCredentialMetadata("slack_channel", "bot_token", {});

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
      const storedBotToken = !!getSecureKey(
        "credential:slack_channel:bot_token",
      );
      const storedAppToken = !!getSecureKey(
        "credential:slack_channel:app_token",
      );
      return {
        success: false,
        hasBotToken: storedBotToken,
        hasAppToken: storedAppToken,
        connected: storedBotToken && storedAppToken,
        error: 'Invalid app token: must start with "xapp-"',
      };
    }

    const stored = await setSecureKeyAsync(
      "credential:slack_channel:app_token",
      appToken,
    );
    if (!stored) {
      const storedBotToken = !!getSecureKey(
        "credential:slack_channel:bot_token",
      );
      const storedAppToken = !!getSecureKey(
        "credential:slack_channel:app_token",
      );
      return {
        success: false,
        hasBotToken: storedBotToken,
        hasAppToken: storedAppToken,
        connected: storedBotToken && storedAppToken,
        error: "Failed to store app token in secure storage",
      };
    }

    upsertCredentialMetadata("slack_channel", "app_token", {});
  }

  const hasBotToken = !!getSecureKey("credential:slack_channel:bot_token");
  const hasAppToken = !!getSecureKey("credential:slack_channel:app_token");

  if (hasBotToken && !hasAppToken) {
    warning =
      "Bot token stored but app token is missing — connection incomplete.";
  } else if (!hasBotToken && hasAppToken) {
    warning =
      "App token stored but bot token is missing — connection incomplete.";
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
  const r1 = await deleteSecureKeyAsync("credential:slack_channel:bot_token");
  const r2 = await deleteSecureKeyAsync("credential:slack_channel:app_token");

  if (r1 === "error" || r2 === "error") {
    const hasBotToken = !!getSecureKey("credential:slack_channel:bot_token");
    const hasAppToken = !!getSecureKey("credential:slack_channel:app_token");
    return {
      success: false,
      hasBotToken,
      hasAppToken,
      connected: hasBotToken && hasAppToken,
      error: "Failed to delete Slack channel credentials from secure storage",
    };
  }

  deleteCredentialMetadata("slack_channel", "bot_token");
  deleteCredentialMetadata("slack_channel", "app_token");

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
