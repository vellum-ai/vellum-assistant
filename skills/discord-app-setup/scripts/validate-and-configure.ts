#!/usr/bin/env bun
/**
 * Validates the stored Discord bot token and captures application metadata.
 *
 * Reads the bot token from the credential store, calls Discord's API to
 * verify the token, and stores the bot user / application metadata as
 * non-secret config values:
 *   - discord_channel.applicationId
 *   - discord_channel.publicKey
 *   - discord_channel.botUserId
 *   - discord_channel.botUsername
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

const DISCORD_API = "https://discord.com/api/v10";

type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
};

type DiscordApplication = {
  id: string;
  name: string;
  verify_key: string;
  owner?: { id: string; username: string } | null;
};

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

async function setConfig(key: string, value: string): Promise<void> {
  const proc = Bun.spawn(["assistant", "config", "set", key, value], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to set config ${key}`);
  }
}

async function discordGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "VellumAssistant (discord-app-setup, 1.0)",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discord ${path} → ${res.status} ${res.statusText}: ${body}`,
    );
  }
  return (await res.json()) as T;
}

async function configureVellum(): Promise<void> {
  const token = await revealCredential("discord_channel", "bot_token");
  if (!token) {
    throw new Error(
      "discord_channel:bot_token is empty. Run the bot-token prompt first.",
    );
  }

  const me = await discordGet<DiscordUser>("/users/@me", token);
  const app = await discordGet<DiscordApplication>(
    "/oauth2/applications/@me",
    token,
  );

  await setConfig("discord_channel.applicationId", app.id);
  await setConfig("discord_channel.publicKey", app.verify_key);
  await setConfig("discord_channel.botUserId", me.id);
  await setConfig("discord_channel.botUsername", me.username);

  console.log(
    JSON.stringify(
      {
        ok: true,
        application: { id: app.id, name: app.name },
        bot: { id: me.id, username: me.username },
        owner: app.owner ?? null,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      try {
        await configureVellum();
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
