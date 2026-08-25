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
   * The app's own Default Install Settings, when the developer has configured
   * them on the portal's Installation page. Discord's current model: scopes
   * and permissions belong to the app, and the install link carries only the
   * client id.
   */
  install_params?: { scopes?: string[]; permissions?: string };
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

  const params = "install_params" in body ? body.install_params : undefined;
  const rawScopes =
    typeof params === "object" &&
    params !== null &&
    "scopes" in params &&
    Array.isArray(params.scopes)
      ? params.scopes
      : [];
  const scopes = rawScopes.filter(
    (scope): scope is string => typeof scope === "string",
  );

  return {
    id,
    ...(scopes.length > 0 ? { install_params: { scopes } } : {}),
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
  const configured = Boolean(app.install_params?.scopes?.length);
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
