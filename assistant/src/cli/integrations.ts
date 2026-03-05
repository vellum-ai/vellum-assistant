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

  const telegram = integrations
    .command("telegram")
    .description("Telegram integration status");

  telegram
    .command("config")
    .description("Get Telegram integration configuration status")
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/telegram/config"),
      );
    });

  const guardian = integrations
    .command("guardian")
    .description("Guardian verification status");

  guardian
    .command("status")
    .description("Get guardian status for a channel")
    .option("--channel <channel>", "Channel: telegram|voice|sms", "telegram")
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

  twilio
    .command("config")
    .description("Get Twilio credential and phone number status")
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/twilio/config"),
      );
    });

  twilio
    .command("numbers")
    .description("List Twilio incoming phone numbers")
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/twilio/numbers"),
      );
    });

  const twilioSms = twilio.command("sms").description("Twilio SMS status");

  twilioSms
    .command("compliance")
    .description("Get Twilio SMS compliance status")
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

  ingress
    .command("config")
    .description("Get public ingress URL and local gateway target")
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readIngressConfig());
    });

  const voice = integrations.command("voice").description("Voice setup status");

  voice
    .command("config")
    .description("Get voice and call readiness config")
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readVoiceConfig());
    });
}
