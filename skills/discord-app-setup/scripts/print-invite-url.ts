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

/**
 * The permission bits the integration actually exercises, checked against an
 * app's own Default Install Settings. Derived from the code, not the request
 * preset above: the transport sends messages and uploads attachments
 * (`assistant/src/messaging/providers/discord/send.ts`), thread messages are
 * admitted so replies land in threads, and the typing indicator rides
 * SEND_MESSAGES. Nothing writes reactions, reads message history, or
 * registers application commands, so tightening those away must not warn:
 * an admin who removes bits the code never uses has improved the install.
 */
const REQUIRED_PERMISSION_BITS: Record<string, bigint> = {
  VIEW_CHANNEL: 10n,
  SEND_MESSAGES: 11n,
  ATTACH_FILES: 15n,
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

export interface DiscordApplication {
  id: string;
  /**
   * The app's own install settings, undefined when it has none.
   *
   * Resolved from the two places Discord may put them. The portal's
   * Installation page writes its Default Install Settings to
   * `integration_types_config["0"].oauth2_install_params` (`0` is
   * GUILD_INSTALL, the server install this integration performs). Top-level
   * `install_params` is the older in-app authorization link, still served
   * for apps that configured it. Reading only the legacy field would leave
   * this undefined for every app configured through the current portal, and
   * the preference for the app's own settings would silently never engage.
   *
   * The permission string rides along because deferring to the app's
   * settings removes the least-privilege bound the parameterized URL used to
   * carry, and the caller can only re-check that bound against what the
   * settings actually grant.
   */
  installSettings: InstallSettings | undefined;
}

interface InstallSettings {
  scopes: string[];
  /** Decimal permission bitfield as Discord serves it, if present. */
  permissions: string | undefined;
}

/** An install-params-shaped object's settings; undefined without scopes. */
function readInstallSettings(params: unknown): InstallSettings | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const rawScopes = "scopes" in params ? params.scopes : undefined;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (scopes.length === 0) {
    return undefined;
  }
  const permissions =
    "permissions" in params && typeof params.permissions === "string"
      ? params.permissions
      : undefined;
  return { scopes, permissions };
}

/**
 * Narrow Discord's response rather than assert it. This is one hop from the
 * network and the id it yields goes into an install link someone clicks, so a
 * shape Discord did not send should stop here loudly instead of producing a
 * link to nothing.
 */
export function readApplication(body: unknown): DiscordApplication {
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
    typeof typesConfig === "object" &&
    typesConfig !== null &&
    "0" in typesConfig
      ? typesConfig["0"]
      : undefined;
  const guildInstall = readInstallSettings(
    typeof guildConfig === "object" &&
      guildConfig !== null &&
      "oauth2_install_params" in guildConfig
      ? guildConfig.oauth2_install_params
      : undefined,
  );
  const legacy = readInstallSettings(
    "install_params" in body ? body.install_params : undefined,
  );

  return { id, installSettings: guildInstall ?? legacy };
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
  const plan = planInvite(app);

  console.log(plan.url);
  for (const note of plan.notes) {
    console.error(note);
  }
}

/** The invite URL to print and the stderr notes that go with it. */
export interface InvitePlan {
  url: string;
  notes: string[];
}

/**
 * Decide the invite URL for an application, as data so the decision is
 * testable apart from credential IO and printing.
 *
 * Prefers the app's own install link: Discord's current model puts scopes
 * and permissions in Default Install Settings on the portal's Installation
 * page and generates a link carrying only the client id, so a person who
 * edits those settings sees the change. Spelling them into the URL instead
 * silently overrides what they configured.
 */
export function planInvite(app: DiscordApplication): InvitePlan {
  const settings = app.installSettings;

  // A client-id-only link installs whatever the settings say, so settings
  // that omit the bot scope would produce an install that adds no bot user
  // at all, and the setup flow dead-ends with a URL that looked right. Stop
  // instead of printing it: the settings are authoritative, so the fix
  // belongs where they live.
  if (settings && !settings.scopes.includes("bot")) {
    throw new Error(
      "This app's Default Install Settings do not include the bot scope, " +
        "so installing it would not add a bot user to the server. Add the " +
        "bot scope on the portal's Installation page, then rerun.",
    );
  }

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", app.id);

  if (!settings) {
    // No Default Install Settings, so the link has to say what to grant.
    // `applications.commands` is deliberately absent: Discord includes it
    // with the `bot` scope, and nothing here registers a command, so asking
    // for it separately requests a permission that is never exercised.
    url.searchParams.set("permissions", computeDefaultPermissions());
    url.searchParams.set("scope", "bot");
    return { url: url.toString(), notes: [] };
  }

  const notes = [
    "Using this app's Default Install Settings from the Installation page.",
  ];
  // Deferring to the app's settings means this script no longer bounds what
  // the install grants, so say when those settings ask for more than the
  // integration uses. `gdm.join` matters most: it lets the bot be added to
  // group DMs, which arrive guild-less and are admitted by ingress as
  // private DMs. The ingress gate documents that assumption and must learn
  // to tell the two apart before that scope is safe to carry.
  const surplus = settings.scopes.filter(
    (scope) => scope !== "bot" && scope !== "applications.commands",
  );
  if (surplus.length > 0) {
    notes.push(
      `Warning: the app's Default Install Settings request scopes this ` +
        `integration never uses: ${surplus.join(", ")}. Remove them on the ` +
        `portal's Installation page. In particular, gdm.join would let the ` +
        `bot join group DMs, which inbound handling treats as private DMs.`,
    );
  }
  notes.push(...permissionWarnings(settings.permissions));
  return { url: url.toString(), notes };
}

/**
 * Re-check the bound the parameterized URL used to carry, against the bits
 * the integration exercises rather than the fallback request preset: the
 * preset is what we ask for on a fresh app, and an admin who tightened
 * their settings below it but kept {@link REQUIRED_PERMISSION_BITS} has
 * improved the install and must not be told to widen it back.
 *
 * Administrator grants every permission, which the skill forbids
 * requesting, and settings missing required bits produce a bot that joins
 * but cannot see or answer. Both are the app owner's settings to fix, so
 * they warn with the exact edit rather than failing an install that will
 * technically complete.
 */
export function permissionWarnings(permissions: string | undefined): string[] {
  if (permissions === undefined || !/^\d+$/.test(permissions)) {
    return [];
  }
  const granted = BigInt(permissions);
  const ADMINISTRATOR = 1n << 3n;
  if ((granted & ADMINISTRATOR) !== 0n) {
    return [
      `Warning: the app's Default Install Settings grant Administrator. ` +
        `This integration needs only ${computeDefaultPermissions()}; set ` +
        `that on the portal's Installation page instead.`,
    ];
  }
  const missing = Object.entries(REQUIRED_PERMISSION_BITS)
    .filter(([, bit]) => (granted & (1n << bit)) === 0n)
    .map(([name]) => name);
  if (missing.length > 0) {
    return [
      `Warning: the app's Default Install Settings omit permissions this ` +
        `integration uses: ${missing.join(", ")}. The bot may join but fail ` +
        `to see or answer messages. Grant them on the portal's Installation ` +
        `page (the requested default is ${computeDefaultPermissions()}).`,
    ];
  }
  return [];
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

if (import.meta.main) {
  main();
}
