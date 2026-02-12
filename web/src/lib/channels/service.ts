import { randomBytes } from "crypto";

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
import { downloadTelegramPhoto, downloadTelegramDocument } from "@/lib/channels/plugins/telegram";
import { DomainError } from "@/lib/auth/server-session";
import { createRuntimeClient } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

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
    throw new DomainError("Telegram channel plugin is not registered");
  }

  const existing = await getAssistantChannelAccount(params.assistantId, "telegram");
  const isActiveRotation =
    Boolean(existing && existing.enabled && existing.status === "active");
  const provisionalConfig = {
    ...(existing?.config || {}),
    ...(isActiveRotation ? {} : { botToken: params.botToken }),
  };

  const provisional = await upsertAssistantChannelAccount({
    assistantId: params.assistantId,
    channel: "telegram",
    accountKey: "default",
    // Keep an already-active channel live during token rotation.
    enabled: isActiveRotation,
    status: "connecting",
    config: provisionalConfig,
    lastError: null,
  });

  const webhookSecret = randomBytes(24).toString("hex");
  const webhookUrl = `${getAppBaseUrl()}/api/webhooks/channels/telegram/${provisional.id}`;
  let didConfigureRemoteWebhook = false;

  try {
    const result = await plugin.setup.connect({
      channelAccountId: provisional.id,
      botToken: params.botToken,
      webhookUrl,
      webhookSecret,
    });
    didConfigureRemoteWebhook = true;

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
      const existingConfig = getTelegramConfig((existing.config || {}) as Record<string, unknown>);
      if (didConfigureRemoteWebhook) {
        const rollbackBotToken = existingConfig.botToken;
        const rollbackWebhookSecret = existingConfig.webhookSecret;
        const rollbackWebhookUrl =
          typeof existingConfig.webhookUrl === "string" && existingConfig.webhookUrl
            ? existingConfig.webhookUrl
            : webhookUrl;

        if (!rollbackBotToken || !rollbackWebhookSecret) {
          const disabled = await upsertAssistantChannelAccount({
            assistantId: params.assistantId,
            channel: "telegram",
            accountKey: existing.account_key,
            enabled: false,
            status: "error",
            config: (existing.config || {}) as Record<string, unknown>,
            lastError: `${message} (rollback unavailable; channel disabled)`,
          });
          throw new DomainError(
            `Telegram connection failed: ${message} (rollback unavailable; disabled account ${disabled.id})`
          );
        }

        try {
          await plugin.setup.connect({
            channelAccountId: existing.id,
            botToken: rollbackBotToken,
            webhookUrl: rollbackWebhookUrl,
            webhookSecret: rollbackWebhookSecret,
          });
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error
              ? rollbackError.message
              : "Failed to restore previous Telegram webhook configuration";
          const disabled = await upsertAssistantChannelAccount({
            assistantId: params.assistantId,
            channel: "telegram",
            accountKey: existing.account_key,
            enabled: false,
            status: "error",
            config: (existing.config || {}) as Record<string, unknown>,
            lastError: `${message} (rollback failed: ${rollbackMessage})`,
          });
          throw new DomainError(
            `Telegram connection failed: ${message} (rollback failed: ${rollbackMessage}; disabled account ${disabled.id})`
          );
        }
      }

      await upsertAssistantChannelAccount({
        assistantId: params.assistantId,
        channel: "telegram",
        accountKey: existing.account_key,
        enabled: true,
        status: "active",
        config: (existing.config || {}) as Record<string, unknown>,
        lastError: message,
      });

      throw new DomainError(
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
    throw new DomainError(
      `Telegram connection failed: ${message} (account ${failed.id})`
    );
  }
}

export async function disconnectTelegramChannel(assistantId: string) {
  const plugin = getChannelPlugin("telegram");
  if (!plugin) {
    throw new DomainError("Telegram channel plugin is not registered");
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

  const preserveCredentials = Boolean(disconnectWarning);

  await upsertAssistantChannelAccount({
    assistantId,
    channel: "telegram",
    accountKey: account.account_key,
    enabled: false,
    status: disconnectWarning ? "error" : "inactive",
    config: (preserveCredentials
      ? (account.config || {})
      : {
          ...(account.config || {}),
          botToken: null,
          webhookSecret: null,
          webhookUrl: null,
        }) as Record<string, unknown>,
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
    throw new DomainError("Telegram channel is not configured for this assistant");
  }

  const contact = await getAssistantChannelContactById(params.contactId);
  if (!contact || contact.assistant_channel_account_id !== account.id) {
    throw new DomainError("Contact not found");
  }

  const updated = await updateAssistantChannelContactStatus({
    contactId: params.contactId,
    status: params.status,
  });
  if (!updated) {
    throw new DomainError("Failed to update contact status");
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

function getRuntimeClient(assistantId: string) {
  const { baseUrl } = resolveRuntime(assistantId);
  return createRuntimeClient(baseUrl, assistantId);
}

export async function handleTelegramWebhook(params: {
  channelAccountId: string;
  headers: Headers;
  payload: Record<string, unknown>;
}) {
  const plugin = getChannelPlugin("telegram");
  if (!plugin) {
    throw new DomainError("Telegram channel plugin is not registered");
  }

  const account = await getAssistantChannelAccountById(params.channelAccountId);
  if (!account || account.channel !== "telegram" || !account.enabled) {
    return { status: "ignored", reason: "channel_not_enabled" as const };
  }

  const config = getTelegramConfig((account.config || {}) as Record<string, unknown>);
  const secretValid = plugin.inbound.verifyWebhook({ headers: params.headers, secret: config.webhookSecret ?? undefined });
  if (!secretValid) {
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

  const client = getRuntimeClient(account.assistant_id);

  // Upload any file attachments from the Telegram payload.
  const attachmentIds: string[] = [];
  const rawMessage = params.payload.message as Record<string, unknown> | undefined;
  const photos = rawMessage?.photo as Array<{ file_id: string; file_unique_id: string; file_size?: number; width: number; height: number }> | undefined;
  const document = rawMessage?.document as { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number } | undefined;

  let attachment = null;
  if (Array.isArray(photos) && photos.length > 0 && config.botToken) {
    attachment = await downloadTelegramPhoto(config.botToken, photos);
  } else if (document?.file_id && config.botToken) {
    attachment = await downloadTelegramDocument(config.botToken, document);
  }

  if (attachment) {
    const uploaded = await client.uploadAttachment({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      data: attachment.data,
    });
    attachmentIds.push(uploaded.id);
  }

  // If there is no text and no attachments (e.g. photo download failed),
  // acknowledge the webhook to Telegram but skip the runtime call.
  if (!normalized.text && attachmentIds.length === 0) {
    return { status: "ignored", reason: "no_content" as const };
  }

  const inboundResult = await client.channelInbound({
    sourceChannel: "telegram",
    externalChatId: normalized.externalChatId,
    externalMessageId: normalized.externalMessageId,
    content: normalized.text,
    senderName: normalized.sender.displayName ?? normalized.sender.username ?? undefined,
    attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
  });

  if (!inboundResult.accepted) {
    return { status: "ignored", reason: "not_accepted" as const };
  }

  if (inboundResult.assistantMessage?.content) {
    await plugin.outbound.sendText({
      botToken: config.botToken,
      chatId: normalized.externalChatId,
      text: inboundResult.assistantMessage.content,
    });

    await client.channelDeliveryAck({
      sourceChannel: "telegram",
      externalChatId: normalized.externalChatId,
      externalMessageId: normalized.externalMessageId,
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
