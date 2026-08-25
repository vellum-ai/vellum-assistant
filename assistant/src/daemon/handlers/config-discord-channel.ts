/**
 * Connect and disconnect the Discord bot: the assistant's own identity in a
 * server, not a grant to act as the person who authorized it. The user-scoped
 * `discord` OAuth provider is a different surface and is untouched here.
 *
 * Storing the credential IS the connection. The gateway's Discord client is
 * credential-gated (`gateway/src/index.ts`, "Discord Gateway lifecycle"): the
 * watcher's next tick starts it when the token appears and tears it down when
 * it goes, so there is no webhook to register and no restart to arrange.
 * Slack needs a second token and Telegram a webhook secret; Discord needs one
 * token, which makes this the smallest of the three rather than a port of the
 * largest.
 */

import { z } from "zod";

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { DISCORD_API_BASE_URL } from "../../messaging/providers/discord/api.js";
import {
  ensureManualTokenConnection,
  removeManualTokenConnection,
} from "../../oauth/manual-token-connection.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { ChannelConfigResultBaseSchema } from "./channel-config-result.js";
import { log } from "./shared.js";

/** The provider key the gateway watches and the setup skill already writes. */
const DISCORD_PROVIDER = "discord_channel";

export const DiscordChannelConfigResultSchema =
  ChannelConfigResultBaseSchema.extend({
    /** The bot's own account, read back from Discord when the token validates. */
    botUserId: z.string().optional(),
    botUsername: z.string().optional(),
    /**
     * The application the bot belongs to, which is what an install link is
     * built from. Read from Discord rather than assumed equal to the bot user
     * id: they coincide today, and the install link breaks silently if that
     * ever stops being true.
     */
    applicationId: z.string().optional(),
  });

export type DiscordChannelConfigResult = z.infer<
  typeof DiscordChannelConfigResultSchema
>;

async function hasStoredBotToken(): Promise<boolean> {
  return Boolean(
    await getSecureKeyAsync(credentialKey(DISCORD_PROVIDER, "bot_token")),
  );
}

/** Current state, without touching anything. */
export async function getDiscordChannelConfig(): Promise<DiscordChannelConfigResult> {
  const raw = loadRawConfig() as {
    discord?: {
      botUserId?: string;
      botUsername?: string;
      applicationId?: string;
    };
  };
  const hasToken = await hasStoredBotToken();
  return {
    success: true,
    hasBotToken: hasToken,
    // Credential-gated: the gateway's client exists while the credential
    // does, so a stored token is the connection.
    connected: hasToken,
    ...(raw.discord?.botUserId ? { botUserId: raw.discord.botUserId } : {}),
    ...(raw.discord?.botUsername
      ? { botUsername: raw.discord.botUsername }
      : {}),
    ...(raw.discord?.applicationId
      ? { applicationId: raw.discord.applicationId }
      : {}),
  };
}

/**
 * Validate a bot token with Discord and store it.
 *
 * Validation is `GET /users/@me` under `Bot` auth, which is the same call the
 * setup skill makes at its own validate step, and it answers with the bot's
 * account. Recording that is what lets a connected panel name the bot rather
 * than say "connected": the gateway otherwise learns the bot's identity only
 * at READY, which is after this call and unavailable to it.
 */
export async function setDiscordChannelConfig(
  botToken?: string,
): Promise<DiscordChannelConfigResult> {
  if (!botToken?.trim()) {
    return {
      success: false,
      hasBotToken: await hasStoredBotToken(),
      connected: await hasStoredBotToken(),
      error: "botToken is required",
    };
  }
  const token = botToken.trim();

  let botUserId: string | undefined;
  let botUsername: string | undefined;
  let applicationId: string | undefined;
  try {
    // A direct call rather than `callDiscordApi`: that helper resolves the
    // stored credential, and the token being validated here is not stored
    // yet. Validating before storing is the point, so an invalid token never
    // reaches secure storage and never starts a gateway connection that
    // cannot authenticate.
    const res = await fetch(`${DISCORD_API_BASE_URL}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Discord returned ${res.status}`);
    }
    const me = (await res.json()) as { id?: string; username?: string };
    botUserId = me.id;
    botUsername = me.username;

    const appRes = await fetch(
      `${DISCORD_API_BASE_URL}/oauth2/applications/@me`,
      {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (appRes.ok) {
      const app = (await appRes.json()) as { id?: string };
      applicationId = app.id;
    }
  } catch (err) {
    // Deliberately not echoing the error body: a Discord 401 response is
    // short and safe, but this path is reached with a secret in hand and the
    // caller only needs to know the token was rejected.
    log.warn({ err }, "Discord bot token validation failed");
    return {
      success: false,
      hasBotToken: await hasStoredBotToken(),
      connected: await hasStoredBotToken(),
      error:
        "Discord rejected this bot token. Check it was copied from the Bot tab of your application, and reset it there if it was shown before.",
    };
  }

  const stored = await setSecureKeyAsync(
    credentialKey(DISCORD_PROVIDER, "bot_token"),
    token,
  );
  if (!stored) {
    return {
      success: false,
      hasBotToken: await hasStoredBotToken(),
      connected: await hasStoredBotToken(),
      error: "Failed to store the bot token in secure storage",
    };
  }
  upsertCredentialMetadata(DISCORD_PROVIDER, "bot_token", {});

  const raw = loadRawConfig();
  setNestedValue(raw, "discord.botUserId", botUserId ?? "");
  setNestedValue(raw, "discord.botUsername", botUsername ?? "");
  setNestedValue(raw, "discord.applicationId", applicationId ?? "");
  saveRawConfig(raw);
  invalidateConfigCache();

  await ensureManualTokenConnection(
    DISCORD_PROVIDER,
    botUsername ? `@${botUsername}` : undefined,
  );

  log.info({ botUserId, botUsername }, "Discord bot token stored");
  return {
    success: true,
    hasBotToken: true,
    connected: true,
    ...(botUserId ? { botUserId } : {}),
    ...(botUsername ? { botUsername } : {}),
    ...(applicationId ? { applicationId } : {}),
  };
}

/**
 * Clear the stored credential, which disconnects the bot.
 *
 * The allow-list in config is deliberately left alone. It names rooms rather
 * than credentials, and someone reconnecting the same bot would otherwise find
 * their room choices silently discarded.
 */
export async function clearDiscordChannelConfig(): Promise<DiscordChannelConfigResult> {
  await deleteSecureKeyAsync(credentialKey(DISCORD_PROVIDER, "bot_token"));
  deleteCredentialMetadata(DISCORD_PROVIDER, "bot_token");
  await removeManualTokenConnection(DISCORD_PROVIDER);

  const raw = loadRawConfig();
  setNestedValue(raw, "discord.botUserId", "");
  setNestedValue(raw, "discord.botUsername", "");
  setNestedValue(raw, "discord.applicationId", "");
  saveRawConfig(raw);
  invalidateConfigCache();

  log.info("Discord bot token cleared");
  return { success: true, hasBotToken: false, connected: false };
}
