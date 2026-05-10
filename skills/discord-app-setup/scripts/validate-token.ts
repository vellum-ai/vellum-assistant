#!/usr/bin/env bun
/**
 * Validates the stored Discord bot token by hitting Discord's REST API.
 *
 * Reads the bot token from the credential store, calls `/users/@me` and
 * `/oauth2/applications/@me`, and prints a JSON summary of the bot +
 * application identity. Does NOT persist any of the captured metadata —
 * everything is derivable from the bot token on demand and persisting it
 * risks staleness after a token reset.
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

async function validateVellum(): Promise<void> {
  const token = await revealCredential("discord_channel", "bot_token");
  if (!token) {
    throw new Error(
      "discord_channel:bot_token is empty. Run store-bot-token.ts first.",
    );
  }

  const me = await discordGet<DiscordUser>("/users/@me", token);
  const app = await discordGet<DiscordApplication>(
    "/oauth2/applications/@me",
    token,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        application: { id: app.id, name: app.name, publicKey: app.verify_key },
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
        await validateVellum();
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
