#!/usr/bin/env bun
/**
 * Prints the OAuth2 invite URL for the configured Discord application.
 *
 * Discovers the application ID on the fly by calling Discord's
 * `/oauth2/applications/@me` with the stored bot token, then builds the
 * standard bot invite URL with a least-privilege permission integer
 * computed from a named bit map.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Default permissions — least-privilege baseline for a personal-assistant bot.
 *
 * Bit positions per Discord's permission flags reference:
 * https://discord.com/developers/docs/topics/permissions
 *
 * Deliberately omitted: ADMINISTRATOR, MANAGE_CHANNELS, MANAGE_ROLES,
 * MANAGE_THREADS, CREATE_PUBLIC_THREADS, KICK_MEMBERS, BAN_MEMBERS,
 * MENTION_EVERYONE.
 */
const DEFAULT_PERMISSION_BITS: Record<string, bigint> = {
  VIEW_CHANNEL: 10n,
  SEND_MESSAGES: 11n,
  ADD_REACTIONS: 6n,
  EMBED_LINKS: 14n,
  ATTACH_FILES: 15n,
  READ_MESSAGE_HISTORY: 16n,
  USE_EXTERNAL_EMOJIS: 18n,
  USE_APPLICATION_COMMANDS: 31n,
  SEND_MESSAGES_IN_THREADS: 38n,
};

function computeDefaultPermissions(): string {
  let bits = 0n;
  for (const bit of Object.values(DEFAULT_PERMISSION_BITS)) {
    bits |= 1n << bit;
  }
  return bits.toString();
}

async function revealCredential(
  service: string,
  field: string,
): Promise<string> {
  const proc = Bun.spawn(
    [
      "assistant",
      "credentials",
      "reveal",
      "--service",
      service,
      "--field",
      field,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Could not reveal ${service}:${field}`);
  }
  return stdout.trim();
}

interface DiscordApplication {
  id: string;
  /**
   * The scopes the app's own install settings grant, empty when it has none.
   *
   * Resolved from the two places Discord may put them. The portal's
   * Installation page writes its Default Install Settings to
   * `integration_types_config["0"].oauth2_install_params` (`0` is
   * GUILD_INSTALL, the server install this integration performs). Top-level
   * `install_params` is the older in-app authorization link, still served
   * for apps that configured it. Reading only the legacy field would leave
   * this empty for every app configured through the current portal, and the
   * preference for the app's own settings would silently never engage.
   */
  installScopes: string[];
}

/** The `scopes` array of an install-params-shaped object, if it has one. */
function readScopes(params: unknown): string[] {
  if (typeof params !== "object" || params === null) {
    return [];
  }
  const scopes = "scopes" in params ? params.scopes : undefined;
  if (!Array.isArray(scopes)) {
    return [];
  }
  return scopes.filter((scope): scope is string => typeof scope === "string");
}

/**
 * Narrow Discord's response rather than assert it. This is one hop from the
 * network and the id it yields goes into an install link someone clicks, so a
 * shape Discord did not send should stop here loudly instead of producing a
 * link to nothing.
 */
function readApplication(body: unknown): DiscordApplication {
  if (typeof body !== "object" || body === null) {
    throw new Error("Discord returned a non-object application");
  }
  const id = "id" in body ? body.id : undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Discord returned an application without a usable id");
  }

  const typesConfig =
    "integration_types_config" in body
      ? body.integration_types_config
      : undefined;
  const guildConfig =
    typeof typesConfig === "object" && typesConfig !== null && "0" in typesConfig
      ? typesConfig["0"]
      : undefined;
  const guildInstall = readScopes(
    typeof guildConfig === "object" &&
      guildConfig !== null &&
      "oauth2_install_params" in guildConfig
      ? guildConfig.oauth2_install_params
      : undefined,
  );
  const legacy = readScopes(
    "install_params" in body ? body.install_params : undefined,
  );

  return {
    id,
    installScopes: guildInstall.length > 0 ? guildInstall : legacy,
  };
}

async function fetchApplication(token: string): Promise<DiscordApplication> {
  const res = await fetch(`${DISCORD_API}/oauth2/applications/@me`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "VellumAssistant (discord-app-setup, 1.0)",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discord /oauth2/applications/@me returned ${res.status} ${res.statusText}: ${body}`,
    );
  }
  return readApplication(await res.json());
}

async function printVellum(): Promise<void> {
  const token = await revealCredential("discord_channel", "bot_token");
  if (!token) {
    throw new Error(
      "discord_channel:bot_token is empty. Run store-bot-token.ts first.",
    );
  }

  const app = await fetchApplication(token);

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", app.id);

  // Prefer the app's own install link. Discord's current model puts scopes
  // and permissions in Default Install Settings on the portal's Installation
  // page and generates a link carrying only the client id, so a person who
  // edits those settings sees the change. Spelling them into the URL instead
  // silently overrides what they configured.
  const configured = app.installScopes.length > 0;
  if (!configured) {
    // No Default Install Settings, so the link has to say what to grant.
    // `applications.commands` is deliberately absent: Discord includes it
    // with the `bot` scope, and nothing here registers a command, so asking
    // for it separately requests a permission that is never exercised.
    url.searchParams.set("permissions", computeDefaultPermissions());
    url.searchParams.set("scope", "bot");
  }

  console.log(url.toString());
  if (configured) {
    console.error(
      "Using this app's Default Install Settings from the Installation page.",
    );
    // Deferring to the app's settings means this script no longer bounds what
    // the install grants, so say when those settings ask for more than the
    // integration uses. `gdm.join` matters most: it lets the bot be added to
    // group DMs, which arrive guild-less and are admitted by ingress as
    // private DMs. The ingress gate documents that assumption and must learn
    // to tell the two apart before that scope is safe to carry.
    const surplus = app.installScopes.filter(
      (scope) => scope !== "bot" && scope !== "applications.commands",
    );
    if (surplus.length > 0) {
      console.error(
        `Warning: the app's Default Install Settings request scopes this ` +
          `integration never uses: ${surplus.join(", ")}. Remove them on the ` +
          `portal's Installation page. In particular, gdm.join would let the ` +
          `bot join group DMs, which inbound handling treats as private DMs.`,
      );
    }
  }
}

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      try {
        await printVellum();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. This skill currently only supports species=vellum.`,
      );
      process.exitCode = 1;
  }
}

main();
