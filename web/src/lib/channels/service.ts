import {
  listAssistantChannelAccounts,
} from "@/lib/channels/db";

export type AssistantChannelSummary = {
  id: string;
  channel: string;
  accountKey: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  config: Record<string, unknown>;
};

function redactAccountConfig(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  if ("botToken" in next) {
    delete next.botToken;
  }
  if ("webhookSecret" in next) {
    delete next.webhookSecret;
  }
  return next;
}

export async function listAssistantChannels(
  assistantId: string
): Promise<AssistantChannelSummary[]> {
  const accounts = await listAssistantChannelAccounts(assistantId);
  return accounts.map((account) => ({
    id: account.id,
    channel: account.channel,
    accountKey: account.account_key,
    enabled: account.enabled,
    status: account.status,
    lastError: account.last_error,
    config: redactAccountConfig((account.config || {}) as Record<string, unknown>),
  }));
}
