/**
 * Telegram Private Chat Topics — daemon handlers for gateway-initiated
 * fork / rename / profile / inbound topic-title sync.
 */

import { z } from "zod";

import { findConversation } from "../../daemon/conversation-registry.js";
import { cancelGeneration } from "../../daemon/handlers/conversations.js";
import { ipcCall } from "../../ipc/gateway-client.js";
import {
  createTelegramForumTopic,
  editTelegramForumTopic,
  shouldSkipTelegramTopicRenameEcho,
} from "../../messaging/providers/telegram-bot/forum-topics.js";
import { sendTelegramReply } from "../../messaging/providers/telegram-bot/send.js";
import { resolveVerificationThreadId } from "../../messaging/providers/telegram-bot/verification-topic.js";
import {
  archiveConversation,
  forkConversation,
  getConversation,
  setConversationInferenceProfile,
  updateConversationTitle,
} from "../../persistence/conversation-crud.js";
import { setConversationKeyIfAbsent } from "../../persistence/conversation-key-store.js";
import { buildScopedConversationKey } from "../../persistence/delivery-crud.js";
import {
  getBindingByChannelChatThread,
  upsertBinding,
} from "../../persistence/external-conversation-store.js";
import { getModelProfiles } from "../../plugin-api/model-profiles.js";
import { getLogger } from "../../util/logger.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { deleteBoundChannelThread } from "../channel-thread-cleanup.js";
import {
  publishConversationInferenceProfileChanged,
  publishConversationListAndMetadataChanged,
  publishConversationTitleChanged,
} from "../sync/resource-sync-events.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("telegram-topic-routes");

const ChatThreadBody = z.object({
  chatId: z.string().min(1),
  threadId: z.string().min(1),
});

const RenameBody = ChatThreadBody.extend({
  title: z.string().min(1).max(128),
});

const TopicTitleFromTelegramBody = ChatThreadBody.extend({
  title: z.string().min(1).max(128),
});

const SetProfileBody = z.object({
  chatId: z.string().min(1),
  threadId: z.string().optional(),
  profile: z.string().min(1),
});

const ListProfileBody = z.object({
  chatId: z.string().min(1),
  threadId: z.string().optional(),
});

const THRESHOLD_VALUES = ["none", "low", "medium", "high"] as const;

const GetAccessModeBody = z.object({
  chatId: z.string().min(1),
  threadId: z.string().optional(),
});

const SetAccessModeBody = z.object({
  chatId: z.string().min(1),
  threadId: z.string().optional(),
  threshold: z.enum(THRESHOLD_VALUES),
});

const CreateVerificationThreadBody = z.object({
  chatId: z.string().min(1),
});

const StopBody = z.object({
  chatId: z.string().min(1),
  threadId: z.string().optional(),
});

function resolveTelegramBinding(chatId: string, threadId?: string | null) {
  return getBindingByChannelChatThread(
    "telegram",
    chatId,
    threadId?.trim() || null,
  );
}

async function handleForkTopic({ body = {} }: RouteHandlerArgs) {
  const parsed = ChatThreadBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId and threadId are required");
  }
  const { chatId, threadId } = parsed.data;

  const sourceBinding = resolveTelegramBinding(chatId, threadId);
  if (!sourceBinding) {
    throw new NotFoundError("No conversation bound to this Telegram topic");
  }

  const sourceConversation = getConversation(sourceBinding.conversationId);
  if (!sourceConversation) {
    throw new NotFoundError("Bound conversation not found");
  }

  let forked;
  try {
    forked = forkConversation({
      conversationId: sourceBinding.conversationId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(message);
  }

  const topicName = (forked.title ?? "Fork").slice(0, 128);
  const created = await createTelegramForumTopic({
    chatId,
    name: topicName,
  });
  const newThreadId = String(created.messageThreadId);

  upsertBinding({
    conversationId: forked.id,
    sourceChannel: "telegram",
    externalChatId: chatId,
    externalThreadId: newThreadId,
    externalUserId: sourceBinding.externalUserId,
    displayName: sourceBinding.displayName,
    username: sourceBinding.username,
  });

  // Register the thread-scoped conversation key so the first inbound message
  // in the new topic resolves to the forked conversation. The fork creates the
  // conversation out-of-band (not via recordInbound), so without this the
  // inbound path would build the same key, find no mapping, and spin up a fresh
  // conversation — orphaning the fork and re-titling the topic.
  setConversationKeyIfAbsent(
    buildScopedConversationKey("telegram", chatId, newThreadId),
    forked.id,
  );

  const notice = `Forked from “${sourceConversation.title ?? "conversation"}”. History is available in Vellum; this topic starts fresh in Telegram.`;
  await sendTelegramReply(chatId, notice, undefined, {
    messageThreadId: newThreadId,
  });

  log.info(
    {
      chatId,
      sourceThreadId: threadId,
      newThreadId,
      sourceConversationId: sourceBinding.conversationId,
      forkedConversationId: forked.id,
    },
    "Forked Telegram topic conversation",
  );

  return {
    ok: true as const,
    conversationId: forked.id,
    threadId: newThreadId,
    title: topicName,
  };
}

async function handleRenameTopic({ body = {} }: RouteHandlerArgs) {
  const parsed = RenameBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId, threadId, and title are required");
  }
  const { chatId, threadId, title } = parsed.data;
  const binding = resolveTelegramBinding(chatId, threadId);
  if (!binding) {
    throw new NotFoundError("No conversation bound to this Telegram topic");
  }

  await editTelegramForumTopic({
    chatId,
    messageThreadId: threadId,
    name: title,
  });
  updateConversationTitle(binding.conversationId, title, 0);
  // The topic was just renamed directly above; skip the channel sync so the
  // title-changed event does not push a redundant second rename to Telegram.
  publishConversationTitleChanged(binding.conversationId, title, undefined, {
    skipChannelSync: true,
  });

  return { ok: true as const };
}

async function handleArchiveTopic({ body = {} }: RouteHandlerArgs) {
  const parsed = ChatThreadBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId and threadId are required");
  }
  const { chatId, threadId } = parsed.data;
  const binding = resolveTelegramBinding(chatId, threadId);
  if (!binding) {
    throw new NotFoundError("No conversation bound to this Telegram topic");
  }

  const conversation = getConversation(binding.conversationId);
  const title = conversation?.title ?? null;

  archiveConversation(binding.conversationId);
  // Archiving deletes the bound thread through the shared cleanup path — the
  // same one the web/CLI archive routes trigger — so this stays a single
  // source of truth for "archive closes the Telegram thread".
  await deleteBoundChannelThread(binding.conversationId);
  publishConversationListAndMetadataChanged(
    "reordered",
    binding.conversationId,
  );

  log.info(
    { chatId, threadId, conversationId: binding.conversationId },
    "Archived Telegram topic conversation",
  );

  return { ok: true as const, conversationId: binding.conversationId, title };
}

function handleTopicTitleFromTelegram({ body = {} }: RouteHandlerArgs) {
  const parsed = TopicTitleFromTelegramBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId, threadId, and title are required");
  }
  const { chatId, threadId, title } = parsed.data;

  if (shouldSkipTelegramTopicRenameEcho(chatId, threadId, title)) {
    return { ok: true as const, skipped: true as const };
  }

  const binding = resolveTelegramBinding(chatId, threadId);
  if (!binding) {
    throw new NotFoundError("No conversation bound to this Telegram topic");
  }

  updateConversationTitle(binding.conversationId, title, 0);
  publishConversationTitleChanged(binding.conversationId, title, undefined, {
    skipChannelSync: true,
  });
  return { ok: true as const, skipped: false as const };
}

function handleListProfiles({ body = {} }: RouteHandlerArgs) {
  const parsed = ListProfileBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId is required");
  }
  const { chatId, threadId } = parsed.data;
  const binding = resolveTelegramBinding(chatId, threadId ?? null);
  if (!binding) {
    throw new NotFoundError(
      "No conversation bound to this Telegram chat/topic",
    );
  }

  const conversation = getConversation(binding.conversationId);
  const profiles = getModelProfiles().filter((profile) => !profile.isDisabled);
  return {
    ok: true as const,
    conversationId: binding.conversationId,
    currentProfile: conversation?.inferenceProfile ?? null,
    profiles: profiles.map((profile) => ({
      key: profile.key,
      label: profile.label,
    })),
  };
}

function handleSetProfile({ body = {} }: RouteHandlerArgs) {
  const parsed = SetProfileBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId and profile are required");
  }
  const { chatId, threadId, profile } = parsed.data;
  const binding = resolveTelegramBinding(chatId, threadId ?? null);
  if (!binding) {
    throw new NotFoundError(
      "No conversation bound to this Telegram chat/topic",
    );
  }

  const known = getModelProfiles().find(
    (entry) => entry.key === profile && !entry.isDisabled,
  );
  if (!known) {
    throw new BadRequestError(`Unknown or disabled profile: ${profile}`);
  }

  // Mirror the web setter: persist, then reflect onto the live conversation
  // and broadcast so an in-flight/active turn and every connected client pick
  // up the new profile instead of reading the stale in-memory value.
  setConversationInferenceProfile(binding.conversationId, profile);
  findConversation(binding.conversationId)?.applyInferenceProfileState({
    profile,
    sessionId: null,
    expiresAt: null,
  });
  publishConversationInferenceProfileChanged({
    conversationId: binding.conversationId,
    profile,
    sessionId: null,
    expiresAt: null,
  });
  return { ok: true as const, profile, label: known.label };
}

async function handleGetAccessMode({ body = {} }: RouteHandlerArgs) {
  const parsed = GetAccessModeBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId is required");
  }
  const { chatId, threadId } = parsed.data;
  const binding = resolveTelegramBinding(chatId, threadId ?? null);
  if (!binding) {
    throw new NotFoundError(
      "No conversation bound to this Telegram chat/topic",
    );
  }

  // Mirror the web composer: a per-conversation override wins, otherwise the
  // global interactive threshold is the effective mode.
  const override = (await ipcCall("get_conversation_threshold", {
    conversationId: binding.conversationId,
  })) as { threshold: string } | null | undefined;
  let currentThreshold = override?.threshold ?? null;
  if (!currentThreshold) {
    const global = (await ipcCall("get_global_thresholds")) as
      | { interactive: string }
      | null
      | undefined;
    currentThreshold = global?.interactive ?? null;
  }

  return {
    ok: true as const,
    conversationId: binding.conversationId,
    currentThreshold,
  };
}

async function handleSetAccessMode({ body = {} }: RouteHandlerArgs) {
  const parsed = SetAccessModeBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId and a valid threshold are required");
  }
  const { chatId, threadId, threshold } = parsed.data;
  const binding = resolveTelegramBinding(chatId, threadId ?? null);
  if (!binding) {
    throw new NotFoundError(
      "No conversation bound to this Telegram chat/topic",
    );
  }

  const result = await ipcCall("set_conversation_threshold", {
    conversationId: binding.conversationId,
    threshold,
  });
  if (result === undefined) {
    throw new InternalError("Failed to persist assistant access mode");
  }

  return { ok: true as const, threshold };
}

/**
 * Create a dedicated verification bot thread for a chat when the bot runs in
 * threaded mode. Unlike the other handlers this needs no conversation binding —
 * it fires during guardian bootstrap, before any conversation exists. Returns a
 * null threadId (main chat) when threaded mode is off or creation failed.
 */
function handleStopTopic({ body = {} }: RouteHandlerArgs) {
  const parsed = StopBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId is required");
  }
  const { chatId, threadId } = parsed.data;
  const binding = resolveTelegramBinding(chatId, threadId ?? null);
  if (!binding) {
    throw new NotFoundError(
      "No conversation bound to this Telegram chat/topic",
    );
  }

  const cancelled = cancelGeneration(binding.conversationId);
  log.info(
    { chatId, threadId, conversationId: binding.conversationId, cancelled },
    "Stopped Telegram topic conversation generation",
  );
  return { ok: true as const, cancelled };
}

async function handleCreateVerificationThread({ body = {} }: RouteHandlerArgs) {
  const parsed = CreateVerificationThreadBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("chatId is required");
  }
  const threadId = await resolveVerificationThreadId(parsed.data.chatId);
  return { ok: true as const, threadId: threadId ?? null };
}

export const TELEGRAM_TOPIC_ROUTES: RouteDefinition[] = [
  {
    operationId: "telegram_fork_topic",
    endpoint: "channels/telegram/fork-topic",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Fork a Telegram topic conversation",
    tags: ["channels"],
    handler: handleForkTopic,
  },
  {
    operationId: "telegram_rename_topic",
    endpoint: "channels/telegram/rename-topic",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Rename a Telegram topic and its Vellum conversation",
    tags: ["channels"],
    handler: handleRenameTopic,
  },
  {
    operationId: "telegram_archive_topic",
    endpoint: "channels/telegram/archive-topic",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Archive a Telegram topic conversation and close its thread",
    tags: ["channels"],
    handler: handleArchiveTopic,
  },
  {
    operationId: "telegram_topic_title_from_telegram",
    endpoint: "channels/telegram/topic-title",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Apply a Telegram forum_topic_edited name to Vellum",
    tags: ["channels"],
    handler: handleTopicTitleFromTelegram,
  },
  {
    operationId: "telegram_list_profiles",
    endpoint: "channels/telegram/profiles",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "List inference profiles for a Telegram chat/topic binding",
    tags: ["channels"],
    handler: handleListProfiles,
  },
  {
    operationId: "telegram_set_profile",
    endpoint: "channels/telegram/profiles/set",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Set inference profile for a Telegram chat/topic binding",
    tags: ["channels"],
    handler: handleSetProfile,
  },
  {
    operationId: "telegram_get_access_mode",
    endpoint: "channels/telegram/access-mode",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Get assistant access mode for a Telegram chat/topic binding",
    tags: ["channels"],
    handler: handleGetAccessMode,
  },
  {
    operationId: "telegram_set_access_mode",
    endpoint: "channels/telegram/access-mode/set",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Set assistant access mode for a Telegram chat/topic binding",
    tags: ["channels"],
    handler: handleSetAccessMode,
  },
  {
    operationId: "telegram_stop_topic",
    endpoint: "channels/telegram/stop-topic",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Interrupt the running agent for a Telegram chat/topic binding",
    tags: ["channels"],
    handler: handleStopTopic,
  },
  {
    operationId: "telegram_create_verification_thread",
    endpoint: "channels/telegram/verification-thread",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Create a Telegram verification bot thread (threaded mode)",
    tags: ["channels"],
    handler: handleCreateVerificationThread,
  },
];
