#!/usr/bin/env bun
/**
 * Prints the OAuth2 invite URL for the configured Discord application.
 *
 * Reads `discord_channel.applicationId` from config, computes the default
 * permission integer from a named bit map (least-privilege baseline), and
 * writes the URL to stdout. The user opens it in a browser to add the bot
 * to a server.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

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

async function getConfig(key: string): Promise<string> {
  const proc = Bun.spawn(["assistant", "config", "get", key], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return "";
  }
  return stdout.trim();
}

async function printVellum(): Promise<void> {
  const applicationId = await getConfig("discord_channel.applicationId");
  if (!applicationId) {
    console.error(
      "discord_channel.applicationId is not set. Run validate-and-configure.ts first.",
    );
    process.exitCode = 1;
    return;
  }

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", applicationId);
  url.searchParams.set("permissions", computeDefaultPermissions());
  url.searchParams.set("scope", "bot applications.commands");

  console.log(url.toString());
}

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      await printVellum();
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. This skill currently only supports species=vellum.`,
      );
      process.exitCode = 1;
  }
}

main();
