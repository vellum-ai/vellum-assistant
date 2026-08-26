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
  getConfig,
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

/**
 * The fields read back from Discord when a token validates. Parsed rather than
 * cast: this runs at a network boundary and what it keeps is written into
 * config, so a shape Discord did not send should fail here rather than persist
 * as an undefined the reader silently tolerates.
 */
const DiscordBotIdentitySchema = z.object({
  id: z.string().optional(),
  username: z.string().optional(),
});

/**
 * The application read, including its own install settings. The portal's
 * Installation page writes Default Install Settings to
 * `integration_types_config["0"].oauth2_install_params` (`0` is
 * GUILD_INSTALL); top-level `install_params` is the older in-app
 * authorization link, still served for apps that configured it.
 */
const DiscordInstallParamsSchema = z.object({
  scopes: z.array(z.string()).optional(),
});
const DiscordApplicationSchema = z.object({
  id: z.string().optional(),
  install_params: DiscordInstallParamsSchema.optional(),
  integration_types_config: z
    .record(
      z.string(),
      z.object({
        oauth2_install_params: DiscordInstallParamsSchema.optional(),
      }),
    )
    .optional(),
});

/**
 * The permission integer a parameterized invite link requests: View Channels,
 * Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read
 * Message History, Add Reactions, Use External Emojis, Use Slash Commands.
 * The setup skill's invite script derives the same integer from named bits;
 * skills are import-isolated from this package, so the value is stated here
 * and pinned equal by the connect test.
 */
const DISCORD_INVITE_PERMISSIONS = "277025770560";

/**
 * The install link for the application, total over every app state.
 *
 * An app whose own install settings grant the `bot` scope gets a link
 * carrying only the client id, so the grant is whatever the owner configured
 * and an edit on the portal's Installation page takes effect. Any other app,
 * including the fresh one the wizard's create step just made, gets the
 * parameterized link: a client-id-only link installs nothing without
 * settings, and explicit scope and permission parameters are honored
 * regardless of them.
 */
function buildDiscordInviteUrl(
  app: z.infer<typeof DiscordApplicationSchema>,
): string | undefined {
  if (!app.id) {
    return undefined;
  }
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", app.id);
  const settingsScopes =
    app.integration_types_config?.["0"]?.oauth2_install_params?.scopes ??
    app.install_params?.scopes ??
    [];
  if (!settingsScopes.includes("bot")) {
    url.searchParams.set("permissions", DISCORD_INVITE_PERMISSIONS);
    url.searchParams.set("scope", "bot");
  }
  return url.toString();
}

export const DiscordChannelConfigResultSchema =
  ChannelConfigResultBaseSchema.extend({
    /** The bot's own account, read back from Discord when the token validates. */
    botUserId: z.string().optional(),
    botUsername: z.string().optional(),
    /**
     * The application the bot belongs to. Read from Discord rather than
     * assumed equal to the bot user id: they coincide today, and anything
     * built on that assumption breaks silently if it ever stops being true.
     */
    applicationId: z.string().optional(),
    /**
     * The install link for the bot's application, computed daemon-side from
     * the application's own install settings so no client re-derives the
     * grant rules. Absent until a token has validated.
     */
    inviteUrl: z.string().optional(),
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
  const { discord } = getConfig();
  const hasToken = await hasStoredBotToken();
  return {
    success: true,
    hasBotToken: hasToken,
    connected: hasToken,
    ...(discord.botUserId ? { botUserId: discord.botUserId } : {}),
    ...(discord.botUsername ? { botUsername: discord.botUsername } : {}),
    ...(discord.applicationId ? { applicationId: discord.applicationId } : {}),
    ...(discord.inviteUrl ? { inviteUrl: discord.inviteUrl } : {}),
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
  let inviteUrl: string | undefined;
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
    const me = DiscordBotIdentitySchema.parse(await res.json());
    botUserId = me.id;
    botUsername = me.username;

    if (appRes?.ok) {
      const app = DiscordApplicationSchema.safeParse(await appRes.json());
      if (app.success) {
        applicationId = app.data.id;
        inviteUrl = buildDiscordInviteUrl(app.data);
      }
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
  setNestedValue(raw, "discord.inviteUrl", inviteUrl ?? "");
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
    ...(inviteUrl ? { inviteUrl } : {}),
  };
}

/**
 * Clear the stored credential, which disconnects the bot.
 *
 * A legacy `discord.allowedChannelIds` entry, where one exists, is left
 * alone on purpose: the gateway still enforces it as persisted operator
 * intent, so reconnecting the same bot must not silently widen its room
 * scope by clearing it here.
 */
export async function clearDiscordChannelConfig(): Promise<DiscordChannelConfigResult> {
  const deleted = await deleteSecureKeyAsync(
    credentialKey(DISCORD_PROVIDER, "bot_token"),
  );
  if (deleted === "error") {
    // The token is still stored, so the gateway's client stays connected: a
    // success here would report a disconnect that did not happen.
    return failure("Failed to delete the bot token from secure storage");
  }
  deleteCredentialMetadata(DISCORD_PROVIDER, "bot_token");
  await removeManualTokenConnection(DISCORD_PROVIDER);

  const raw = loadRawConfig();
  setNestedValue(raw, "discord.botUserId", "");
  setNestedValue(raw, "discord.botUsername", "");
  setNestedValue(raw, "discord.applicationId", "");
  setNestedValue(raw, "discord.inviteUrl", "");
  saveRawConfig(raw);
  invalidateConfigCache();

  log.info("Discord bot token cleared");
  return { success: true, hasBotToken: false, connected: false };
}
