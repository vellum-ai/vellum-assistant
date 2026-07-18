/**
 * Slash-command and service-message handlers for Telegram Private Chat Topics.
 */

import type { Logger } from "pino";

import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { resolveTrustVerdict } from "../risk/trust-verdict-resolver.js";
import { TELEGRAM_BOT_COMMANDS } from "./commands.js";
import {
  applyTelegramTopicTitleFromTelegram,
  archiveTelegramTopic,
  forkTelegramTopic,
  getTelegramTopicAccessMode,
  listTelegramTopicProfiles,
  renameTelegramTopic,
  setTelegramTopicAccessMode,
  setTelegramTopicProfile,
  stopTelegramTopic,
} from "../runtime/client.js";
import { sendTelegramReply } from "./send.js";
import { telegramSendOpts } from "./topics.js";
import {
  type InlineKeyboard,
  resolveTopicSwitcher,
  sendTopicSwitcher,
} from "./topic-switchers.js";

/**
 * Assistant access modes surfaced by `/access`, mapped onto the gateway
 * auto-approve interactive threshold. Ordered least → most permissive to
 * match the web composer's "Assistant Access" menu.
 */
const ACCESS_MODES = [
  { threshold: "none", label: "Strict" },
  { threshold: "low", label: "Conservative" },
  { threshold: "medium", label: "Relaxed" },
  { threshold: "high", label: "Full access" },
] as const;

type AccessThreshold = (typeof ACCESS_MODES)[number]["threshold"];

function isAccessThreshold(value: string): value is AccessThreshold {
  return ACCESS_MODES.some((mode) => mode.threshold === value);
}

function accessModeLabel(threshold: string): string {
  return (
    ACCESS_MODES.find((mode) => mode.threshold === threshold)?.label ??
    threshold
  );
}

const FORK_THREAD_ONLY =
  " /fork only works inside a topic. Open or create a topic, then try again.";
const ARCHIVE_THREAD_ONLY =
  " /archive only works inside a topic. Open a topic, then send /archive.";
const RENAME_THREAD_ONLY =
  " /rename only works inside a topic. Open a topic, then send /rename <name>.";
const RENAME_GUARDIAN_ONLY = "Only a guardian can rename a topic.";
const RENAME_USAGE = "Usage: /rename <new name>";
const ACCESS_GUARDIAN_ONLY =
  "Only a guardian can change the assistant access mode.";

export function parseTelegramForkCommand(content: string): boolean {
  return /^\/fork(?:@\w+)?(?:\s|$)/i.test(content.trim());
}

export function parseTelegramRenameCommand(
  content: string,
): { name?: string } | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^\/rename(?:@\w+)?(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const name = match[1]?.trim();
  return name ? { name } : {};
}

export function parseTelegramArchiveCommand(content: string): boolean {
  return /^\/archive(?:@\w+)?(?:\s|$)/i.test(content.trim());
}

export function parseTelegramStopCommand(content: string): boolean {
  return /^\/stop(?:@\w+)?(?:\s|$)/i.test(content.trim());
}

export function parseTelegramProfileCommand(content: string): boolean {
  return /^\/profile(?:@\w+)?(?:\s|$)/i.test(content.trim());
}

export function parseTelegramAccessCommand(content: string): boolean {
  return /^\/access(?:@\w+)?(?:\s|$)/i.test(content.trim());
}

export function parseTelegramHelpCommand(content: string): boolean {
  return /^\/help(?:@\w+)?(?:\s|$)/i.test(content.trim());
}

export function parseTelegramProfileCallback(
  data: string,
): { profile: string } | null {
  if (!data.startsWith("prf:")) {
    return null;
  }
  const profile = data.slice(4).trim();
  return profile ? { profile } : null;
}

export function parseTelegramAccessCallback(
  data: string,
): { threshold: AccessThreshold } | null {
  if (!data.startsWith("acc:")) {
    return null;
  }
  const threshold = data.slice(4).trim();
  if (!isAccessThreshold(threshold)) {
    return null;
  }
  return { threshold };
}

type Caches = {
  credentials?: CredentialCache;
  configFile?: ConfigFileCache;
};

async function isGuardianActor(params: {
  chatId: string;
  actorExternalId: string;
}): Promise<boolean> {
  const verdict = await resolveTrustVerdict({
    channelType: "telegram",
    actorExternalId: params.actorExternalId,
  });
  return verdict.trustClass === "guardian";
}

export async function handleTelegramForkCommand(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, logger } = params;
  const sendOpts = telegramSendOpts(caches, threadId);
  if (!threadId) {
    await sendTelegramReply(
      config,
      chatId,
      FORK_THREAD_ONLY,
      undefined,
      sendOpts,
    );
    return;
  }
  try {
    await forkTelegramTopic(config, chatId, threadId);
  } catch (err) {
    logger.error({ err, chatId, threadId }, "Failed to fork Telegram topic");
    await sendTelegramReply(
      config,
      chatId,
      "Could not fork this topic. Make sure the topic has an active conversation, then try again.",
      undefined,
      sendOpts,
    );
  }
}

export async function handleTelegramArchiveCommand(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, logger } = params;
  if (!threadId) {
    await sendTelegramReply(
      config,
      chatId,
      ARCHIVE_THREAD_ONLY,
      undefined,
      telegramSendOpts(caches, threadId),
    );
    return;
  }
  try {
    const { title } = await archiveTelegramTopic(config, chatId, threadId);
    // The topic thread is deleted by the archive, so confirm in the main chat.
    const named = title ? `“${title}”` : "this topic";
    await sendTelegramReply(
      config,
      chatId,
      `Archived ${named}. The topic is now closed; find it under Archived in Vellum.`,
      undefined,
      telegramSendOpts(caches),
    );
  } catch (err) {
    logger.error({ err, chatId, threadId }, "Failed to archive Telegram topic");
    await sendTelegramReply(
      config,
      chatId,
      "Could not archive this topic. Make sure it has an active conversation, then try again.",
      undefined,
      telegramSendOpts(caches, threadId),
    );
  }
}

export async function handleTelegramStopCommand(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, logger } = params;
  const sendOpts = telegramSendOpts(caches, threadId);
  try {
    const { cancelled } = await stopTelegramTopic(config, chatId, threadId);
    await sendTelegramReply(
      config,
      chatId,
      cancelled ? "Stopped." : "Nothing is running right now.",
      undefined,
      sendOpts,
    );
  } catch (err) {
    logger.error({ err, chatId, threadId }, "Failed to stop Telegram agent");
    await sendTelegramReply(
      config,
      chatId,
      "Nothing is running right now.",
      undefined,
      sendOpts,
    );
  }
}

export async function handleTelegramRenameCommand(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  actorExternalId: string;
  name?: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, actorExternalId, name, logger } =
    params;
  const sendOpts = telegramSendOpts(caches, threadId);
  if (!threadId) {
    await sendTelegramReply(
      config,
      chatId,
      RENAME_THREAD_ONLY,
      undefined,
      sendOpts,
    );
    return;
  }
  if (!(await isGuardianActor({ chatId, actorExternalId }))) {
    await sendTelegramReply(
      config,
      chatId,
      RENAME_GUARDIAN_ONLY,
      undefined,
      sendOpts,
    );
    return;
  }
  if (!name) {
    await sendTelegramReply(config, chatId, RENAME_USAGE, undefined, sendOpts);
    return;
  }
  try {
    // The renamed topic title is its own confirmation — no reply needed.
    await renameTelegramTopic(config, chatId, threadId, name);
  } catch (err) {
    logger.error({ err, chatId, threadId }, "Failed to rename Telegram topic");
    await sendTelegramReply(
      config,
      chatId,
      "Could not rename this topic. Please try again.",
      undefined,
      sendOpts,
    );
  }
}

export async function handleTelegramProfileCommand(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, logger } = params;
  const sendOpts = telegramSendOpts(caches, threadId);
  try {
    const { profiles, currentProfile } = await listTelegramTopicProfiles(
      config,
      chatId,
      threadId,
    );
    if (profiles.length === 0) {
      await sendTelegramReply(
        config,
        chatId,
        "No inference profiles are available.",
        undefined,
        sendOpts,
      );
      return;
    }
    const keyboard: InlineKeyboard = {
      inline_keyboard: profiles.slice(0, 20).map((profile) => [
        {
          text:
            profile.key === currentProfile
              ? `✓ ${profile.label}`
              : profile.label,
          callback_data: `prf:${profile.key}`.slice(0, 64),
        },
      ]),
    };
    await sendTopicSwitcher({
      caches,
      chatId,
      threadId,
      text: "Choose an inference profile for this chat/topic:",
      keyboard,
    });
  } catch (err) {
    logger.error({ err, chatId, threadId }, "Failed to list Telegram profiles");
    await sendTelegramReply(
      config,
      chatId,
      "Could not load profiles for this chat. Send a message first, then try /profile again.",
      undefined,
      sendOpts,
    );
  }
}

export async function handleTelegramHelpCommand(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, logger } = params;
  const lines = [
    "Available commands:",
    ...TELEGRAM_BOT_COMMANDS.map(
      (cmd) => `/${cmd.command} — ${cmd.description}`,
    ),
  ];
  try {
    await sendTelegramReply(
      config,
      chatId,
      lines.join("\n"),
      undefined,
      telegramSendOpts(caches, threadId),
    );
  } catch (err) {
    logger.error({ err, chatId }, "Failed to send Telegram help");
  }
}

export async function handleTelegramProfileCallback(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  messageId?: string;
  profile: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, messageId, profile, logger } =
    params;
  try {
    const { label } = await setTelegramTopicProfile(
      config,
      chatId,
      profile,
      threadId,
    );
    await resolveTopicSwitcher({
      caches,
      chatId,
      threadId,
      messageId,
      text: `Using ${label} profile.`,
    });
  } catch (err) {
    logger.error({ err, chatId, profile }, "Failed to set Telegram profile");
    await sendTelegramReply(
      config,
      chatId,
      "Could not set that profile. Please try again.",
      undefined,
      telegramSendOpts(caches, threadId),
    );
  }
}

export async function handleTelegramAccessCommand(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  actorExternalId: string;
  logger: Logger;
}): Promise<void> {
  const { config, caches, chatId, threadId, actorExternalId, logger } = params;
  if (!(await isGuardianActor({ chatId, actorExternalId }))) {
    await sendTelegramReply(
      config,
      chatId,
      ACCESS_GUARDIAN_ONLY,
      undefined,
      telegramSendOpts(caches, threadId),
    );
    return;
  }

  try {
    const { currentThreshold } = await getTelegramTopicAccessMode(
      config,
      chatId,
      threadId,
    );
    const keyboard: InlineKeyboard = {
      inline_keyboard: ACCESS_MODES.map((mode) => [
        {
          text:
            mode.threshold === currentThreshold
              ? `✓ ${mode.label}`
              : mode.label,
          callback_data: `acc:${mode.threshold}`,
        },
      ]),
    };
    await sendTopicSwitcher({
      caches,
      chatId,
      threadId,
      text: "Choose the assistant access mode for this chat/topic:",
      keyboard,
    });
  } catch (err) {
    logger.error({ err, chatId }, "Failed to show assistant access modes");
    await sendTelegramReply(
      config,
      chatId,
      "Could not load access modes for this chat. Send a message first, then try /access again.",
      undefined,
      telegramSendOpts(caches, threadId),
    );
  }
}

export async function handleTelegramAccessCallback(params: {
  config: GatewayConfig;
  caches?: Caches;
  chatId: string;
  threadId?: string;
  messageId?: string;
  actorExternalId: string;
  threshold: string;
  logger: Logger;
}): Promise<void> {
  const {
    config,
    caches,
    chatId,
    threadId,
    messageId,
    actorExternalId,
    threshold,
    logger,
  } = params;
  if (!(await isGuardianActor({ chatId, actorExternalId }))) {
    await sendTelegramReply(
      config,
      chatId,
      ACCESS_GUARDIAN_ONLY,
      undefined,
      telegramSendOpts(caches, threadId),
    );
    return;
  }
  try {
    await setTelegramTopicAccessMode(config, chatId, threshold, threadId);
    await resolveTopicSwitcher({
      caches,
      chatId,
      threadId,
      messageId,
      text: `Using ${accessModeLabel(threshold)} assistant access mode.`,
    });
  } catch (err) {
    logger.error(
      { err, chatId, threshold },
      "Failed to set assistant access mode",
    );
    await sendTelegramReply(
      config,
      chatId,
      "Could not update the access mode. Please try again.",
      undefined,
      telegramSendOpts(caches, threadId),
    );
  }
}

export async function handleTelegramForumTopicEdited(params: {
  config: GatewayConfig;
  chatId: string;
  threadId?: string;
  title: string;
  logger: Logger;
}): Promise<void> {
  const { config, chatId, threadId, title, logger } = params;
  if (!threadId || !title.trim()) {
    return;
  }
  try {
    await applyTelegramTopicTitleFromTelegram(
      config,
      chatId,
      threadId,
      title.trim(),
    );
  } catch (err) {
    logger.warn(
      { err, chatId, threadId },
      "Failed to sync forum_topic_edited to Vellum",
    );
  }
}
