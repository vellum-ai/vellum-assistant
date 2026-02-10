import { randomBytes } from "crypto";

import { handleInboundAssistantMessage } from "@/lib/assistants/message-service";
import {
  AssistantChannelContactRecord,
  AssistantChannelContactStatus,
  getAssistantChannelAccount,
  getAssistantChannelAccountById,
  getAssistantChannelContactByExternalUser,
  getAssistantChannelContactById,
  listAssistantChannelAccounts,
  listAssistantChannelContacts,
  touchAssistantChannelContactPairingPrompt,
  updateAssistantChannelContactStatus,
  upsertAssistantChannelAccount,
  upsertAssistantChannelContact,
} from "@/lib/channels/db";
import { getChannelPlugin } from "@/lib/channels/plugins";

type TelegramAccountConfig = {
  botToken?: string | null;
  botId?: number | null;
  botUsername?: string | null;
  webhookSecret?: string | null;
  webhookUrl?: string | null;
  connectedAt?: string | null;
};

export type AssistantChannelSummary = {
  id: string;
  channel: string;
  accountKey: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  config: Record<string, unknown>;
};

function getAppBaseUrl() {
  const appUrl = process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!appUrl) {
    throw new Error("APP_URL or VERCEL_PROJECT_PRODUCTION_URL is required");
  }
  return appUrl.startsWith("http") ? appUrl : `https://${appUrl}`;
}

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

function getTelegramConfig(config: Record<string, unknown>): TelegramAccountConfig {
  return (config || {}) as TelegramAccountConfig;
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

export async function connectTelegramChannel(params: {
  assistantId: string;
  botToken: string;
  enabled?: boolean;
}) {
  const plugin = getChannelPlugin("telegram");
  if (!plugin) {
    throw new Error("Telegram channel plugin is not registered");
  }

  const existing = await getAssistantChannelAccount(params.assistantId, "telegram");
  const provisionalConfig = {
    ...(existing?.config || {}),
    botToken: params.botToken,
  };

  const provisional = await upsertAssistantChannelAccount({
    assistantId: params.assistantId,
    channel: "telegram",
    accountKey: "default",
    // Keep channel disabled until Telegram webhook setup succeeds.
    enabled: false,
    status: "connecting",
    config: provisionalConfig,
    lastError: null,
  });

  const webhookSecret = randomBytes(24).toString("hex");
  const webhookUrl = `${getAppBaseUrl()}/api/webhooks/channels/telegram/${provisional.id}`;

  try {
    const result = await plugin.setup.connect({
      channelAccountId: provisional.id,
      botToken: params.botToken,
      webhookUrl,
      webhookSecret,
    });

    const updated = await upsertAssistantChannelAccount({
      assistantId: params.assistantId,
      channel: "telegram",
      accountKey: "default",
      enabled: params.enabled ?? true,
      status: "active",
      config: {
        ...(provisional.config || {}),
        ...result.config,
      },
      lastError: null,
    });

    return {
      accountId: updated.id,
      channel: updated.channel,
      status: updated.status,
      enabled: updated.enabled,
      config: redactAccountConfig((updated.config || {}) as Record<string, unknown>),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to connect Telegram";

    if (existing && existing.enabled && existing.status === "active") {
      await upsertAssistantChannelAccount({
        assistantId: params.assistantId,
        channel: "telegram",
        accountKey: existing.account_key,
        enabled: true,
        status: "active",
        config: (existing.config || {}) as Record<string, unknown>,
        lastError: message,
      });

      throw new Error(
        `Telegram connection failed: ${message} (kept existing active channel)`
      );
    }

    const failed = await upsertAssistantChannelAccount({
      assistantId: params.assistantId,
      channel: "telegram",
      accountKey: "default",
      enabled: false,
      status: "error",
      config: provisionalConfig,
      lastError: message,
    });
    throw new Error(
      `Telegram connection failed: ${message} (account ${failed.id})`
    );
  }
}

export async function disconnectTelegramChannel(assistantId: string) {
  const plugin = getChannelPlugin("telegram");
  if (!plugin) {
    throw new Error("Telegram channel plugin is not registered");
  }

  const account = await getAssistantChannelAccount(assistantId, "telegram");
  if (!account) {
    return { success: true };
  }

  const telegramConfig = getTelegramConfig(
    (account.config || {}) as Record<string, unknown>
  );
  let disconnectWarning: string | null = null;
  if (telegramConfig.botToken) {
    try {
      await plugin.setup.disconnect({ botToken: telegramConfig.botToken });
    } catch (error) {
      disconnectWarning =
        error instanceof Error
          ? error.message
          : "Failed to disconnect Telegram webhook";
      console.warn(
        "Failed to disconnect Telegram webhook remotely; proceeding with local disconnect:",
        error
      );
    }
  }

  await upsertAssistantChannelAccount({
    assistantId,
    channel: "telegram",
    accountKey: account.account_key,
    enabled: false,
    status: "inactive",
    config: {
      ...(account.config || {}),
      botToken: null,
      webhookSecret: null,
      webhookUrl: null,
    } as Record<string, unknown>,
    lastError: disconnectWarning,
  });

  return disconnectWarning
    ? { success: true, warning: disconnectWarning }
    : { success: true };
}

export async function listTelegramContacts(params: {
  assistantId: string;
  status?: AssistantChannelContactStatus;
}) {
  const account = await getAssistantChannelAccount(params.assistantId, "telegram");
  if (!account) {
    return [] as AssistantChannelContactRecord[];
  }

  return listAssistantChannelContacts({
    channelAccountId: account.id,
    status: params.status,
  });
}

async function updateTelegramContactStatus(params: {
  assistantId: string;
  contactId: string;
  status: AssistantChannelContactStatus;
}) {
  const account = await getAssistantChannelAccount(params.assistantId, "telegram");
  if (!account) {
    throw new Error("Telegram channel is not configured for this assistant");
  }

  const contact = await getAssistantChannelContactById(params.contactId);
  if (!contact || contact.assistant_channel_account_id !== account.id) {
    throw new Error("Contact not found");
  }

  const updated = await updateAssistantChannelContactStatus({
    contactId: params.contactId,
    status: params.status,
  });
  if (!updated) {
    throw new Error("Failed to update contact status");
  }

  return updated;
}

export async function approveTelegramContact(assistantId: string, contactId: string) {
  return updateTelegramContactStatus({
    assistantId,
    contactId,
    status: "approved",
  });
}

export async function blockTelegramContact(assistantId: string, contactId: string) {
  return updateTelegramContactStatus({
    assistantId,
    contactId,
    status: "blocked",
  });
}

function shouldSendPairingPrompt(contact: AssistantChannelContactRecord): boolean {
  if (!contact.last_pairing_prompt_at) {
    return true;
  }
  const lastPromptMs = new Date(contact.last_pairing_prompt_at).getTime();
  return Date.now() - lastPromptMs > 5 * 60 * 1000;
}

export async function handleTelegramWebhook(params: {
  channelAccountId: string;
  headers: Headers;
  payload: Record<string, unknown>;
}) {
  const plugin = getChannelPlugin("telegram");
  if (!plugin) {
    throw new Error("Telegram channel plugin is not registered");
  }

  const account = await getAssistantChannelAccountById(params.channelAccountId);
  if (!account || account.channel !== "telegram" || !account.enabled) {
    return { status: "ignored", reason: "channel_not_enabled" as const };
  }

  const config = getTelegramConfig((account.config || {}) as Record<string, unknown>);
  if (!plugin.inbound.verifyWebhook({ headers: params.headers, secret: config.webhookSecret ?? undefined })) {
    return { status: "ignored", reason: "invalid_secret" as const };
  }

  const normalized = plugin.inbound.normalizeMessage(params.payload);
  if (!normalized) {
    return { status: "ignored", reason: "unsupported_payload" as const };
  }

  const contact = await upsertAssistantChannelContact({
    channelAccountId: account.id,
    externalUserId: normalized.sender.externalUserId,
    externalChatId: normalized.externalChatId,
    username: normalized.sender.username ?? null,
    displayName: normalized.sender.displayName ?? null,
  });

  if (contact.status === "blocked") {
    return { status: "ignored", reason: "blocked_contact" as const };
  }

  if (contact.status !== "approved") {
    if (config.botToken && shouldSendPairingPrompt(contact)) {
      await plugin.outbound.sendText({
        botToken: config.botToken,
        chatId: normalized.externalChatId,
        text: "This assistant is private. Ask the owner to approve your Telegram contact in the assistant settings.",
      });
      await touchAssistantChannelContactPairingPrompt(contact.id);
    }
    return { status: "pending_approval" as const };
  }

  if (!config.botToken) {
    return { status: "ignored", reason: "missing_bot_token" as const };
  }

  const result = await handleInboundAssistantMessage({
    assistantId: account.assistant_id,
    content: normalized.text,
    sourceChannel: "telegram",
    externalChatId: normalized.externalChatId,
    externalMessageId: normalized.externalMessageId,
    sender: normalized.sender,
  });

  if (result.duplicate) {
    if (result.assistantMessage?.content) {
      await plugin.outbound.sendText({
        botToken: config.botToken,
        chatId: normalized.externalChatId,
        text: result.assistantMessage.content,
      });
      return { status: "ok" as const, duplicate: true as const };
    }

    return { status: "ignored", reason: "duplicate_message" as const };
  }

  if (result.assistantMessage?.content) {
    await plugin.outbound.sendText({
      botToken: config.botToken,
      chatId: normalized.externalChatId,
      text: result.assistantMessage.content,
    });
  }

  return { status: "ok" as const };
}

export async function notifyApprovedTelegramContact(params: {
  assistantId: string;
  contactId: string;
}) {
  const plugin = getChannelPlugin("telegram");
  if (!plugin) {
    return;
  }

  const account = await getAssistantChannelAccount(params.assistantId, "telegram");
  if (!account) {
    return;
  }

  const config = getTelegramConfig((account.config || {}) as Record<string, unknown>);
  if (!config.botToken) {
    return;
  }

  const contact = await getAssistantChannelContactById(params.contactId);
  if (!contact || contact.assistant_channel_account_id !== account.id) {
    return;
  }

  await plugin.outbound.sendText({
    botToken: config.botToken,
    chatId: contact.external_chat_id,
    text: "You are now approved to chat with this assistant.",
  });
}

export async function getTelegramChannelAccountForAssistant(assistantId: string) {
  return getAssistantChannelAccount(assistantId, "telegram");
}

export async function getTelegramContactByExternalUser(params: {
  channelAccountId: string;
  externalUserId: string;
}) {
  return getAssistantChannelContactByExternalUser(params);
}
