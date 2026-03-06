import type { Command } from "commander";

import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/elevenlabs-schema.js";
import { getGatewayInternalBaseUrl } from "../config/env.js";
import { loadRawConfig } from "../config/loader.js";
import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
  mintEdgeRelayToken,
} from "../runtime/auth/token-service.js";

type GuardianChannel = "telegram" | "voice" | "sms";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function shouldOutputJson(cmd: Command): boolean {
  let current: Command | null = cmd;
  while (current) {
    if ((current.opts() as { json?: boolean }).json) return true;
    current = current.parent;
  }
  return false;
}

export function writeOutput(cmd: Command, payload: unknown): void {
  const compact = shouldOutputJson(cmd);
  process.stdout.write(
    compact
      ? JSON.stringify(payload) + "\n"
      : JSON.stringify(payload, null, 2) + "\n",
  );
}

function getGatewayToken(): string {
  const existing = process.env.GATEWAY_AUTH_TOKEN?.trim();
  if (existing) return existing;

  if (!isSigningKeyInitialized()) {
    initAuthSigningKey(loadOrCreateSigningKey());
  }

  return mintEdgeRelayToken();
}

export function toQueryString(
  params: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function readIngressConfig(): {
  success: true;
  enabled: boolean;
  publicBaseUrl?: string;
  localGatewayTarget: string;
} {
  const raw = loadRawConfig();
  const ingress = asRecord(raw.ingress);
  const configuredUrl =
    typeof ingress.publicBaseUrl === "string"
      ? ingress.publicBaseUrl.trim()
      : "";
  const explicitEnabled =
    typeof ingress.enabled === "boolean" ? ingress.enabled : undefined;
  const enabled = explicitEnabled ?? configuredUrl.length > 0;

  return {
    success: true,
    enabled,
    publicBaseUrl: configuredUrl || undefined,
    localGatewayTarget: getGatewayInternalBaseUrl(),
  };
}

function readVoiceConfig(): {
  success: true;
  callsEnabled: boolean;
  voiceId: string;
  configuredVoiceId?: string;
  usesDefaultVoice: boolean;
} {
  const raw = loadRawConfig();
  const calls = asRecord(raw.calls);
  const elevenlabs = asRecord(raw.elevenlabs);
  const configuredVoiceId =
    typeof elevenlabs.voiceId === "string" ? elevenlabs.voiceId.trim() : "";

  return {
    success: true,
    callsEnabled: calls.enabled === true,
    voiceId: configuredVoiceId || DEFAULT_ELEVENLABS_VOICE_ID,
    configuredVoiceId: configuredVoiceId || undefined,
    usesDefaultVoice: configuredVoiceId.length === 0,
  };
}

// CLI-specific gateway helper — uses GATEWAY_AUTH_TOKEN env var for out-of-process
// access. See runtime/gateway-internal-client.ts for daemon-internal usage which
// mints fresh tokens.
export async function gatewayGet(path: string): Promise<unknown> {
  const gatewayBase = getGatewayInternalBaseUrl();
  const token = getGatewayToken();

  const response = await fetch(`${gatewayBase}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const rawBody = await response.text();
  let parsed: unknown = { ok: false, error: rawBody };

  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      parsed = { ok: false, error: rawBody };
    }
  }

  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : `Gateway request failed (${response.status})`;
    throw new Error(`${message} [${response.status}]`);
  }

  return parsed;
}

export async function gatewayPost(
  path: string,
  body: unknown,
): Promise<unknown> {
  const gatewayBase = getGatewayInternalBaseUrl();
  const token = getGatewayToken();

  const response = await fetch(`${gatewayBase}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const rawBody = await response.text();
  let parsed: unknown = { ok: false, error: rawBody };

  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      parsed = { ok: false, error: rawBody };
    }
  }

  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : `Gateway request failed (${response.status})`;
    throw new Error(`${message} [${response.status}]`);
  }

  return parsed;
}

export async function runRead(
  cmd: Command,
  reader: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await reader();
    writeOutput(cmd, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(cmd, { ok: false, error: message });
    process.exitCode = 1;
  }
}

export function registerIntegrationsCommand(program: Command): void {
  const integrations = program
    .command("integrations")
    .description("Read integration and ingress status through the gateway API")
    .option("--json", "Machine-readable compact JSON output");

  integrations.addHelpText(
    "after",
    `
Reads integration configuration and status through the gateway API. The
daemon must be running for most subcommands (telegram, twilio, guardian)
since they query the gateway. Exceptions: "ingress config" and "voice config"
read from the local config file and do not require the gateway.

Integration categories:
  telegram     Telegram bot configuration and webhook status
  twilio       Twilio credentials, phone numbers, and SMS compliance
  guardian     Guardian trust verification system for contacts
  ingress      Public ingress URL and local gateway target (config-only)
  voice        Voice/call readiness and ElevenLabs voice ID (config-only)

Examples:
  $ vellum integrations telegram config
  $ vellum integrations twilio numbers
  $ vellum integrations guardian status --channel sms`,
  );

  const telegram = integrations
    .command("telegram")
    .description("Telegram integration status");

  telegram.addHelpText(
    "after",
    `
Checks the Telegram bot configuration status through the gateway API.
Requires the daemon to be running.

Examples:
  $ vellum integrations telegram config
  $ vellum integrations telegram config --json`,
  );

  telegram
    .command("config")
    .description("Get Telegram integration configuration status")
    .addHelpText(
      "after",
      `
Returns the Telegram bot token status, webhook URL, and bot username from
the gateway. Requires the daemon to be running.

The response includes whether a bot token is configured, the current webhook
endpoint, and the bot's Telegram username.

Examples:
  $ vellum integrations telegram config
  $ vellum integrations telegram config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/telegram/config"),
      );
    });

  const guardian = integrations
    .command("guardian")
    .description("Guardian verification status");

  guardian.addHelpText(
    "after",
    `
Guardian is the trust verification system for contacts. It tracks whether
contacts on each channel have completed identity verification. Requires
the daemon to be running.

Examples:
  $ vellum integrations guardian status
  $ vellum integrations guardian status --channel voice`,
  );

  guardian
    .command("status")
    .description("Get guardian status for a channel")
    .option("--channel <channel>", "Channel: telegram|voice|sms", "telegram")
    .addHelpText(
      "after",
      `
Returns the guardian verification state for the specified channel. Requires
the daemon to be running.

The --channel flag accepts: telegram, voice, sms. Defaults to telegram if
not specified. The response includes whether guardian verification is active
and the current verification state for that channel.

Examples:
  $ vellum integrations guardian status
  $ vellum integrations guardian status --channel telegram
  $ vellum integrations guardian status --channel voice
  $ vellum integrations guardian status --channel sms --json`,
    )
    .action(async (opts: { channel?: GuardianChannel }, cmd: Command) => {
      const channel = opts.channel ?? "telegram";
      await runRead(cmd, async () =>
        gatewayGet(
          `/v1/integrations/guardian/status${toQueryString({ channel })}`,
        ),
      );
    });

  const twilio = integrations
    .command("twilio")
    .description("Twilio integration status");

  twilio.addHelpText(
    "after",
    `
Covers Twilio credential status, phone number management, and SMS regulatory
compliance. All subcommands require the daemon to be running since they
query the gateway API.

Subcommands:
  config          Check Twilio credential status and phone number configuration
  numbers         List all Twilio incoming phone numbers
  sms compliance  Check SMS regulatory compliance status

Examples:
  $ vellum integrations twilio config
  $ vellum integrations twilio numbers
  $ vellum integrations twilio sms compliance`,
  );

  twilio
    .command("config")
    .description("Get Twilio credential and phone number status")
    .addHelpText(
      "after",
      `
Checks the Twilio credential status and phone number configuration through
the gateway. Requires the daemon to be running.

The response includes whether the Twilio account SID and auth token are
configured, and the currently assigned phone number.

Examples:
  $ vellum integrations twilio config
  $ vellum integrations twilio config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/twilio/config"),
      );
    });

  twilio
    .command("numbers")
    .description("List Twilio incoming phone numbers")
    .addHelpText(
      "after",
      `
Lists all incoming phone numbers associated with the configured Twilio
account. Requires the daemon to be running.

Returns an array of phone number objects with their SID, phone number,
friendly name, and capabilities.

Examples:
  $ vellum integrations twilio numbers
  $ vellum integrations twilio numbers --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/twilio/numbers"),
      );
    });

  const twilioSms = twilio.command("sms").description("Twilio SMS status");

  twilioSms
    .command("compliance")
    .description("Get Twilio SMS compliance status")
    .addHelpText(
      "after",
      `
Checks the SMS regulatory compliance status for the configured Twilio
account. Requires the daemon to be running.

Returns the current compliance state, including whether the account is
approved for SMS messaging and any outstanding compliance requirements.

Examples:
  $ vellum integrations twilio sms compliance
  $ vellum integrations twilio sms compliance --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/twilio/sms/compliance"),
      );
    });

  twilio
    .command("sms-compliance")
    .description('Alias for "vellum integrations twilio sms compliance"')
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/twilio/sms/compliance"),
      );
    });

  const ingress = integrations
    .command("ingress")
    .description("Trusted contact membership and invite status");

  ingress.addHelpText(
    "after",
    `
Shows the public ingress URL and local gateway target URL. Reads from the
local config file and does not require the gateway to be running.

Examples:
  $ vellum integrations ingress config`,
  );

  ingress
    .command("config")
    .description("Get public ingress URL and local gateway target")
    .addHelpText(
      "after",
      `
Shows the public ingress URL and the local gateway target URL. Reads from
the local config file and does not require the gateway to be running.

The response includes whether ingress is enabled, the configured public base
URL (if any), and the local gateway target address. Ingress is considered
enabled if explicitly set to true or if a publicBaseUrl is configured.

Examples:
  $ vellum integrations ingress config
  $ vellum integrations ingress config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readIngressConfig());
    });

  const voice = integrations.command("voice").description("Voice setup status");

  voice.addHelpText(
    "after",
    `
Shows voice and call readiness configuration. Reads from the local config
file and does not require the gateway to be running.

Examples:
  $ vellum integrations voice config`,
  );

  voice
    .command("config")
    .description("Get voice and call readiness config")
    .addHelpText(
      "after",
      `
Shows voice and call readiness status. Reads from the local config file and
does not require the gateway to be running.

The response includes whether calls are enabled, the active ElevenLabs voice
ID (falls back to default if not configured), whether a custom voice ID is
set, and whether the default voice is in use.

Examples:
  $ vellum integrations voice config
  $ vellum integrations voice config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readVoiceConfig());
    });
}
