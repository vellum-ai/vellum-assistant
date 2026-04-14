/**
 * Conversation messaging methods: enqueue, persistUserMessage,
 * redirectToSecurePrompt, and queue/confirmation helpers.
 *
 * Extracted from Conversation to keep the class focused on coordination.
 */

import { v4 as uuid } from "uuid";

import { enrichMessageWithSourcePaths } from "../agent/attachments.js";
import { createUserMessage } from "../agent/message-types.js";
import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { parseChannelId, parseInterfaceId } from "../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import {
  attachInlineAttachmentToMessage,
  attachmentExists,
  AttachmentUploadError,
  linkAttachmentToMessage,
  validateAttachmentUpload,
} from "../memory/attachments-store.js";
import {
  addMessage,
  getConversation,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import {
  syncMessageToDisk,
  updateMetaFile,
} from "../memory/conversation-disk-view.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import type { TrustContext } from "./conversation-runtime-assembly.js";
import type {
  ServerMessage,
  UserMessageAttachment,
} from "./message-protocol.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";

const log = getLogger("conversation-messaging");

interface IngressSecretTarget {
  service: string;
  field: string;
  label: string;
}

const INGRESS_SECRET_TARGETS: Record<string, IngressSecretTarget> = {
  "Anthropic API Key": {
    service: "anthropic",
    field: "api_key",
    label: "Anthropic API Key",
  },
  "GitHub Fine-Grained PAT": {
    service: "github",
    field: "token",
    label: "GitHub Token",
  },
  "GitHub Token": { service: "github", field: "token", label: "GitHub Token" },
  "GitLab Token": { service: "gitlab", field: "token", label: "GitLab Token" },
  "Google API Key": {
    service: "google",
    field: "api_key",
    label: "Google API Key",
  },
  "Google OAuth Client Secret": {
    service: "google",
    field: "client_secret",
    label: "Google OAuth Client Secret",
  },
  "Mailgun API Key": {
    service: "mailgun",
    field: "api_key",
    label: "Mailgun API Key",
  },
  "OpenAI API Key": {
    service: "openai",
    field: "api_key",
    label: "OpenAI API Key",
  },
  "OpenAI Project Key": {
    service: "openai",
    field: "api_key",
    label: "OpenAI API Key",
  },
  "PyPI API Token": {
    service: "pypi",
    field: "api_token",
    label: "PyPI API Token",
  },
  "SendGrid API Key": {
    service: "sendgrid",
    field: "api_key",
    label: "SendGrid API Key",
  },
  "Slack Bot Token": {
    service: "slack",
    field: "bot_token",
    label: "Slack Bot Token",
  },
  "Slack User Token": {
    service: "slack",
    field: "user_token",
    label: "Slack User Token",
  },
  "Slack Webhook": {
    service: "slack",
    field: "webhook_url",
    label: "Slack Webhook URL",
  },
  "Stripe Restricted Key": {
    service: "stripe",
    field: "restricted_key",
    label: "Stripe Restricted Key",
  },
  "Stripe Secret Key": {
    service: "stripe",
    field: "secret_key",
    label: "Stripe Secret Key",
  },
  "Telegram Bot Token": {
    service: "telegram",
    field: "bot_token",
    label: "Telegram Bot Token",
  },
  "Twilio API Key": {
    service: "twilio",
    field: "api_key",
    label: "Twilio API Key",
  },
  "npm Token": { service: "npm", field: "token", label: "npm Token" },
};

export interface RedirectedSecretRecord {
  service: string;
  field: string;
  label: string;
  delivery: "store" | "transient_send";
}

export interface RedirectToSecurePromptOptions {
  onStored?: (record: RedirectedSecretRecord) => void | Promise<void>;
  onComplete?: () => void;
}

function normalizeIngressSecretTypeLabel(detectedType: string): string {
  return detectedType.replace(/\s+\([^)]+\)$/u, "");
}

function resolveIngressSecretTarget(
  detectedTypes: string[],
): IngressSecretTarget {
  const mappedTargets = new Map<string, IngressSecretTarget>();
  for (const detectedType of detectedTypes) {
    const normalizedType = normalizeIngressSecretTypeLabel(detectedType);
    const mapped = INGRESS_SECRET_TARGETS[normalizedType];
    if (!mapped) continue;
    mappedTargets.set(`${mapped.service}:${mapped.field}`, mapped);
  }
  if (mappedTargets.size === 1) return mappedTargets.values().next().value!;

  return {
    service: "detected",
    field: detectedTypes.join(","),
    label: "Secure Credential Entry",
  };
}

// ── Context Interface ────────────────────────────────────────────────

export interface MessagingConversationContext {
  readonly conversationId: string;
  messages: Message[];
  processing: boolean;
  abortController: AbortController | null;
  currentRequestId?: string;
  readonly queue: MessageQueue;
  trustContext?: TrustContext;
  getTurnChannelContext(): TurnChannelContext | null;
  getTurnInterfaceContext(): TurnInterfaceContext | null;
}

function extractTurnChannelContext(
  metadata?: Record<string, unknown>,
): TurnChannelContext | null {
  if (!metadata) return null;
  const userMessageChannel = parseChannelId(metadata.userMessageChannel);
  const assistantMessageChannel = parseChannelId(
    metadata.assistantMessageChannel,
  );
  if (!userMessageChannel || !assistantMessageChannel) return null;
  return { userMessageChannel, assistantMessageChannel };
}

function extractTurnInterfaceContext(
  metadata?: Record<string, unknown>,
): TurnInterfaceContext | null {
  if (!metadata) return null;
  const userMessageInterface = parseInterfaceId(metadata.userMessageInterface);
  const assistantMessageInterface = parseInterfaceId(
    metadata.assistantMessageInterface,
  );
  if (!userMessageInterface || !assistantMessageInterface) return null;
  return { userMessageInterface, assistantMessageInterface };
}

// ── enqueueMessage ───────────────────────────────────────────────────

export function enqueueMessage(
  ctx: MessagingConversationContext,
  content: string,
  attachments: UserMessageAttachment[],
  onEvent: (msg: ServerMessage) => void,
  requestId: string,
  activeSurfaceId?: string,
  currentPage?: string,
  metadata?: Record<string, unknown>,
  options?: { isInteractive?: boolean },
  displayContent?: string,
  transport?: ConversationTransportMetadata,
): { queued: boolean; requestId: string; rejected?: boolean } {
  if (!ctx.processing) {
    return { queued: false, requestId };
  }

  if (!isAssistantFeatureFlagEnabled("chat-message-queue", getConfig())) {
    onEvent({
      type: "error",
      message:
        "The assistant is busy processing another message. Please wait for it to finish before sending a new one.",
      category: "queue_disabled",
    });
    return { queued: false, requestId, rejected: true };
  }

  const turnChannelContext =
    extractTurnChannelContext(metadata) ??
    ctx.getTurnChannelContext() ??
    undefined;
  const turnInterfaceContext =
    extractTurnInterfaceContext(metadata) ??
    ctx.getTurnInterfaceContext() ??
    undefined;
  const accepted = ctx.queue.push({
    content,
    attachments,
    requestId,
    onEvent,
    activeSurfaceId,
    currentPage,
    metadata,
    turnChannelContext,
    turnInterfaceContext,
    isInteractive: options?.isInteractive,
    transport,
    displayContent,
    sentAt: Date.now(),
  });
  if (!accepted) {
    onEvent({
      type: "error",
      message:
        "The assistant is busy and cannot accept more messages right now. Please try again shortly.",
      category: "queue_full",
    });
    return { queued: false, requestId, rejected: true };
  }
  return { queued: true, requestId };
}

// ── persistUserMessage ───────────────────────────────────────────────

export async function persistUserMessage(
  ctx: MessagingConversationContext,
  content: string,
  attachments: UserMessageAttachment[],
  requestId?: string,
  metadata?: Record<string, unknown>,
  displayContent?: string,
): Promise<string> {
  if (ctx.processing) {
    throw new Error("Conversation is already processing a message");
  }

  if (!content.trim() && attachments.length === 0) {
    throw new Error("Message content or attachments are required");
  }

  const reqId = requestId ?? uuid();
  ctx.currentRequestId = reqId;
  ctx.processing = true;
  ctx.abortController = new AbortController();

  try {
    return await persistQueuedMessageBody(
      ctx,
      content,
      attachments,
      reqId,
      metadata,
      displayContent,
    );
  } catch (err) {
    ctx.processing = false;
    ctx.abortController = null;
    ctx.currentRequestId = undefined;
    throw err;
  }
}

// ── persistQueuedMessageBody ─────────────────────────────────────────

/**
 * Persists a user message body (DB row, attachment indexing, origin
 * channel/interface updates, meta file write) without touching the
 * `ctx.processing` flag or request-id bookkeeping.
 *
 * Used by `persistUserMessage` (which sets the processing flag first) and
 * by the batched drain path, which persists multiple sibling messages
 * under a single in-flight turn.
 */
export async function persistQueuedMessageBody(
  ctx: MessagingConversationContext,
  content: string,
  attachments: UserMessageAttachment[],
  requestId: string,
  metadata: Record<string, unknown> | undefined,
  displayContent: string | undefined,
): Promise<string> {
  const attachmentInputs = attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    data: attachment.data,
    extractedText: attachment.extractedText,
    filePath: attachment.filePath,
  }));
  const cleanMessage = createUserMessage(content, attachmentInputs);
  const llmMessage = enrichMessageWithSourcePaths(
    cleanMessage,
    attachmentInputs,
  );
  log.info(
    {
      requestId,
      contentBlockTypes: Array.isArray(llmMessage.content)
        ? llmMessage.content.map((b) => b.type)
        : typeof llmMessage.content,
      attachmentCount: attachments.length,
    },
    "persistUserMessage: content blocks being sent to model",
  );
  ctx.messages.push(llmMessage);

  try {
    const turnCtx =
      extractTurnChannelContext(metadata) ?? ctx.getTurnChannelContext();
    const turnIfCtx =
      extractTurnInterfaceContext(metadata) ?? ctx.getTurnInterfaceContext();
    const provenance = provenanceFromTrustContext(ctx.trustContext);
    const imageSourcePaths: Record<string, string> = {};
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
        imageSourcePaths[`${i}:${a.filename}`] = a.filePath;
      }
    }

    const mergedMetadata = {
      ...(metadata ?? {}),
      ...provenance,
      ...(turnCtx
        ? {
            userMessageChannel: turnCtx.userMessageChannel,
            assistantMessageChannel: turnCtx.assistantMessageChannel,
          }
        : {}),
      ...(turnIfCtx
        ? {
            userMessageInterface: turnIfCtx.userMessageInterface,
            assistantMessageInterface: turnIfCtx.assistantMessageInterface,
          }
        : {}),
      ...(Object.keys(imageSourcePaths).length > 0 ? { imageSourcePaths } : {}),
    };

    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message
    // after restart. The in-memory userMessage (sent to the LLM) still uses
    // the stripped content.
    const contentToPersist = displayContent
      ? JSON.stringify(
          createUserMessage(displayContent, attachmentInputs).content,
        )
      : JSON.stringify(cleanMessage.content);
    const persistedUserMessage = await addMessage(
      ctx.conversationId,
      "user",
      contentToPersist,
      mergedMetadata,
    );

    if (turnCtx) {
      setConversationOriginChannelIfUnset(
        ctx.conversationId,
        turnCtx.userMessageChannel,
      );
    }
    if (turnIfCtx) {
      setConversationOriginInterfaceIfUnset(
        ctx.conversationId,
        turnIfCtx.userMessageInterface,
      );
    }

    // Rewrite meta.json so the on-disk metadata reflects the origin channel
    if (turnCtx || turnIfCtx) {
      const convForMeta = getConversation(ctx.conversationId);
      if (convForMeta) {
        updateMetaFile(convForMeta);
      }
    }

    if (!persistedUserMessage.id) {
      throw new Error("Failed to persist user message");
    }

    // Index user attachments in the attachments table for later retrieval.
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      try {
        // If the attachment already exists in the store (e.g. file-backed
        // attachments uploaded separately), link it directly without
        // re-uploading. This handles the case where data is empty because
        // the attachment content lives on disk.
        if (a.id && attachmentExists(a.id)) {
          linkAttachmentToMessage(persistedUserMessage.id, a.id, i);
          continue;
        }

        if (!a.data) continue;

        const validation = validateAttachmentUpload(a.filename, a.mimeType);
        if (!validation.ok) {
          log.warn(
            { filename: a.filename, error: validation.error },
            "Skipping user attachment indexing: validation failed",
          );
          continue;
        }
        attachInlineAttachmentToMessage(
          persistedUserMessage.id,
          i,
          a.filename,
          a.mimeType,
          a.data,
          { sourcePath: a.filePath },
        );
      } catch (err) {
        if (err instanceof AttachmentUploadError) {
          log.warn(
            { filename: a.filename, error: err.message },
            "Skipping user attachment indexing",
          );
        } else {
          log.error(
            { filename: a.filename, err },
            "Failed to index user attachment",
          );
        }
      }
    }

    // Sync the persisted user message (with attachments) to the disk view
    const conv = getConversation(ctx.conversationId);
    if (conv) {
      syncMessageToDisk(
        ctx.conversationId,
        persistedUserMessage.id,
        conv.createdAt,
      );
    }

    return persistedUserMessage.id;
  } catch (err) {
    ctx.messages.pop();
    throw err;
  }
}

// ── redirectToSecurePrompt ───────────────────────────────────────────

export function redirectToSecurePrompt(
  conversationId: string,
  secretPrompter: SecretPrompter,
  detectedTypes: string[],
  options?: RedirectToSecurePromptOptions,
): void {
  const target = resolveIngressSecretTarget(detectedTypes);

  secretPrompter
    .prompt(
      target.service,
      target.field,
      target.label,
      "Your message contained a secret. Please enter it here instead — it will be stored securely and never sent to the AI.",
      undefined,
      conversationId,
    )
    .then(async (result): Promise<void> => {
      if (!result.value) return;

      const { setSecureKeyAsync } = await import("../security/secure-keys.js");
      const { upsertCredentialMetadata } =
        await import("../tools/credentials/metadata-store.js");

      let wasStored = false;
      if (result.delivery === "transient_send") {
        const { credentialBroker } =
          await import("../tools/credentials/broker.js");
        credentialBroker.injectTransient(
          target.service,
          target.field,
          result.value,
        );
        try {
          upsertCredentialMetadata(target.service, target.field, {});
        } catch (e) {
          log.debug(
            { err: e, service: target.service, field: target.field },
            "Non-critical credential metadata upsert failed",
          );
        }
        wasStored = true;
        log.info(
          {
            service: target.service,
            field: target.field,
            delivery: "transient_send",
          },
          "Ingress redirect: transient credential injected",
        );
      } else {
        const { credentialKey: credKey } =
          await import("../security/credential-key.js");
        const key = credKey(target.service, target.field);
        const stored = await setSecureKeyAsync(key, result.value);
        if (stored) {
          try {
            upsertCredentialMetadata(target.service, target.field, {});
          } catch (e) {
            log.debug(
              { err: e, service: target.service, field: target.field },
              "Non-critical credential metadata upsert failed",
            );
          }
          wasStored = true;
          log.info(
            { service: target.service, field: target.field },
            "Ingress redirect: credential stored",
          );
        } else {
          log.warn(
            { service: target.service, field: target.field },
            "Ingress redirect: secure storage write failed",
          );
        }
      }

      if (wasStored) {
        await options?.onStored?.({
          service: target.service,
          field: target.field,
          label: target.label,
          delivery: result.delivery,
        });
      }
    })
    .catch(() => {
      /* prompt timeout or cancel is fine */
    })
    .finally(() => {
      options?.onComplete?.();
    });
}
