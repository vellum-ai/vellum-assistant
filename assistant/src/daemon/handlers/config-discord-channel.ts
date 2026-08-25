/**
 * Connect and disconnect the Discord bot: the assistant's own identity in a
 * server, not a grant to act as the person who authorized it. The user-scoped
 * `discord` OAuth provider is a different surface and is untouched here.
 *
 * Storing the credential IS the connection. The gateway's Discord client is
 * credential-gated (`gateway/src/index.ts`, "Discord Gateway lifecycle"): the
 * watcher's next tick starts it when the token appears and tears it down when
 * it goes, so there is no webhook to register and no restart to arrange.
 */

import { CHANNEL_BOT_PROVIDER } from "@vellumai/service-contracts/channels";
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

/**
 * From the shared vocabulary rather than a literal: `manual-token-providers`
 * declares this bot's credential fields under the same constant, and a second
 * spelling would be free to disagree with it.
 */
const DISCORD_PROVIDER = CHANNEL_BOT_PROVIDER.discord;

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

/**
 * A failed operation still reports the current state. For Discord "connected"
 * and "has a token" are one question, since the gateway's client exists while
 * the credential does.
 */
async function failure(error: string): Promise<DiscordChannelConfigResult> {
  const hasToken = await hasStoredBotToken();
  return { success: false, hasBotToken: hasToken, connected: hasToken, error };
}

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
 * Recording the bot's own account is what lets a connected panel name it
 * rather than say "connected": the gateway learns that identity only at
 * READY, which no caller here can wait for.
 */
export async function setDiscordChannelConfig(
  botToken?: string,
): Promise<DiscordChannelConfigResult> {
  if (!botToken?.trim()) {
    return failure("botToken is required");
  }
  const token = botToken.trim();

  let botUserId: string | undefined;
  let botUsername: string | undefined;
  let applicationId: string | undefined;
  try {
    // Not `callDiscordApi`: that resolves the stored credential, and this
    // token is not stored yet. Validating first is what keeps an invalid one
    // out of secure storage, where it would start a connection that cannot
    // authenticate.
    const headers = { Authorization: `Bot ${token}` };
    const signal = () => AbortSignal.timeout(10_000);
    // Both answer from the token alone, so they go together. The application
    // read is optional and swallows its own failure: it enriches the result
    // and must never be the reason a valid token is rejected.
    const [res, appRes] = await Promise.all([
      fetch(`${DISCORD_API_BASE_URL}/users/@me`, {
        headers,
        signal: signal(),
      }),
      fetch(`${DISCORD_API_BASE_URL}/oauth2/applications/@me`, {
        headers,
        signal: signal(),
      }).catch(() => null),
    ]);
    if (!res.ok) {
      throw new Error(`Discord returned ${res.status}`);
    }
    const me = (await res.json()) as { id?: string; username?: string };
    botUserId = me.id;
    botUsername = me.username;

    if (appRes?.ok) {
      const app = (await appRes.json()) as { id?: string };
      applicationId = app.id;
    }
  } catch (err) {
    // The body is not echoed: this path runs with a secret in hand, and the
    // caller only needs to know the token was rejected.
    log.warn({ err }, "Discord bot token validation failed");
    return failure(
      "Discord rejected this bot token. Check it was copied from the Bot tab of your application, and reset it there if it was shown before.",
    );
  }

  const stored = await setSecureKeyAsync(
    credentialKey(DISCORD_PROVIDER, "bot_token"),
    token,
  );
  if (!stored) {
    return failure("Failed to store the bot token in secure storage");
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
