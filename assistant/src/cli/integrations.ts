import type { Command } from 'commander';

import { getGatewayInternalBaseUrl } from '../config/env.js';
import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
  mintEdgeRelayToken,
} from '../runtime/auth/token-service.js';

type IngressChannel = 'telegram' | 'voice' | 'sms';
type GuardianChannel = 'telegram' | 'voice' | 'sms';

function shouldOutputJson(cmd: Command): boolean {
  let current: Command | null = cmd;
  while (current) {
    if ((current.opts() as { json?: boolean }).json) return true;
    current = current.parent;
  }
  return false;
}

function writeOutput(cmd: Command, payload: unknown): void {
  const compact = shouldOutputJson(cmd);
  process.stdout.write(
    compact ? JSON.stringify(payload) + '\n' : JSON.stringify(payload, null, 2) + '\n',
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

function toQueryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

async function gatewayGet(path: string): Promise<unknown> {
  const gatewayBase = getGatewayInternalBaseUrl();
  const token = getGatewayToken();

  const response = await fetch(`${gatewayBase}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
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
    const message = typeof parsed === 'object' && parsed && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : `Gateway request failed (${response.status})`;
    throw new Error(`${message} [${response.status}]`);
  }

  return parsed;
}

async function runRead(
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
    .command('integrations')
    .description('Read integration and ingress status through the gateway API')
    .option('--json', 'Machine-readable compact JSON output');

  const telegram = integrations
    .command('telegram')
    .description('Telegram integration status');

  telegram
    .command('config')
    .description('Get Telegram integration configuration status')
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => gatewayGet('/v1/integrations/telegram/config'));
    });

  const guardian = integrations
    .command('guardian')
    .description('Guardian verification status');

  guardian
    .command('status')
    .description('Get guardian status for a channel')
    .option('--channel <channel>', 'Channel: telegram|voice|sms', 'voice')
    .action(async (opts: { channel?: GuardianChannel }, cmd: Command) => {
      const channel = opts.channel ?? 'voice';
      await runRead(cmd, async () =>
        gatewayGet(`/v1/integrations/guardian/status${toQueryString({ channel })}`));
    });

  const twilio = integrations
    .command('twilio')
    .description('Twilio integration status');

  twilio
    .command('config')
    .description('Get Twilio credential and phone number status')
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => gatewayGet('/v1/integrations/twilio/config'));
    });

  twilio
    .command('numbers')
    .description('List Twilio incoming phone numbers')
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => gatewayGet('/v1/integrations/twilio/numbers'));
    });

  const twilioSms = twilio
    .command('sms')
    .description('Twilio SMS status');

  twilioSms
    .command('compliance')
    .description('Get Twilio SMS compliance status')
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => gatewayGet('/v1/integrations/twilio/sms/compliance'));
    });

  twilio
    .command('sms-compliance')
    .description('Alias for "vellum integrations twilio sms compliance"')
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => gatewayGet('/v1/integrations/twilio/sms/compliance'));
    });

  const ingress = integrations
    .command('ingress')
    .description('Trusted contact membership and invite status');

  ingress
    .command('members')
    .description('List trusted ingress members')
    .option('--assistant-id <assistantId>', 'Filter by assistant ID')
    .option('--source-channel <sourceChannel>', 'Filter by source channel')
    .option('--status <status>', 'Filter by member status')
    .option('--policy <policy>', 'Filter by policy')
    .action(async (opts: {
      assistantId?: string;
      sourceChannel?: IngressChannel;
      status?: string;
      policy?: string;
    }, cmd: Command) => {
      const query = toQueryString({
        assistantId: opts.assistantId,
        sourceChannel: opts.sourceChannel,
        status: opts.status,
        policy: opts.policy,
      });
      await runRead(cmd, async () => gatewayGet(`/v1/ingress/members${query}`));
    });

  ingress
    .command('invites')
    .description('List trusted ingress invites')
    .option('--source-channel <sourceChannel>', 'Filter by source channel')
    .option('--status <status>', 'Filter by invite status')
    .action(async (opts: { sourceChannel?: IngressChannel; status?: string }, cmd: Command) => {
      const query = toQueryString({
        sourceChannel: opts.sourceChannel,
        status: opts.status,
      });
      await runRead(cmd, async () => gatewayGet(`/v1/ingress/invites${query}`));
    });
}
