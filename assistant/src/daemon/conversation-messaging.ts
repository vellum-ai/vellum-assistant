/**
 * Conversation messaging methods: enqueue, persistUserMessage,
 * redirectToSecurePrompt, and queue/confirmation helpers.
 *
 * Extracted from Conversation to keep the class focused on coordination.
 */

import { v4 as uuid } from "uuid";

import {
  type AttachmentReferenceInput,
  attachmentsToReferenceBlocks,
  enrichMessageWithSourcePaths,
  type MessageAttachmentInput,
} from "../agent/attachments.js";
import { createUserMessage } from "../agent/message-types.js";
import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import {
  parseChannelId,
  parseClientOs,
  parseInterfaceId,
} from "../channels/types.js";
import {
  buildSlackTimezoneMetadata,
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import {
  attachInlineAttachmentToMessage,
  attachmentExists,
  AttachmentUploadError,
  getAttachmentById,
  getFilePathForAttachment,
  linkAttachmentToMessage,
  validateAttachmentUpload,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  extractAttachmentStoredPaths,
  extractImageSourcePaths,
  getConversation,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
  updateMessageContent,
  updateMessageMetadata,
} from "../persistence/conversation-crud.js";
import {
  syncMessageToDisk,
  updateMetaFile,
} from "../persistence/conversation-disk-view.js";
import type { Message } from "../providers/types.js";
import type { AuthContext } from "../runtime/auth/types.js";
import { getLogger } from "../util/logger.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import type { SlackInboundMessageMetadata } from "./handlers/shared.js";
import type {
  ServerMessage,
  UserMessageAttachment,
} from "./message-protocol.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";
import type { TrustContext } from "./trust-context.js";

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
    service: "slack_channel",
    field: "bot_token",
    label: "Slack Bot Token",
  },
  "Slack User Token": {
    service: "slack_channel",
    field: "user_token",
    label: "Slack User Token",
  },
  "Slack Webhook": {
    service: "slack_channel",
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
  isProcessing(): boolean;
  setProcessing(value: boolean): void;
  abortController: AbortController | null;
  currentRequestId?: string;
  readonly queue: MessageQueue;
  trustContext?: TrustContext;
  authContext?: AuthContext;
  currentTurnAuthContext?: AuthContext;
  currentTurnSourceActorPrincipalId?: string;
  /**
   * OS surface reported by the connected client ("web" | "ios" | "macos" |
   * "android"), re-applied from transport metadata on every inbound message.
   * Persisted under `metadata.client.os` so turn telemetry can attribute the
   * real platform — the transport `interfaceId` is "web" for the web, iOS,
   * and macOS apps alike (they share the web renderer).
   */
  clientOs?: string;
  getTurnChannelContext(): TurnChannelContext | null;
  getTurnInterfaceContext(): TurnInterfaceContext | null;
}

/** Byte length of a base64 payload (padding-aware). */
function base64ByteLength(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * Serialize the text-only portion of a user message for the initial row insert.
 * Attachment media is added afterwards as reference blocks by
 * {@link linkUserAttachmentsAndWriteReferences}, once the attachments are
 * linked and their final ids are known.
 */
function serializePersistedUserTextContent(text: string): string {
  return JSON.stringify(createUserMessage(text, []).content);
}

/**
 * Link a user message's attachments to the message row, then rewrite the row's
 * `content` so each attachment is a workspace reference block
 * ({@link attachmentsToReferenceBlocks}) instead of inline base64. Keeping
 * base64 out of `messages.content` keeps the DB row (and the lexical index)
 * small; the bytes are resolved back at the provider boundary.
 *
 * Mutates `attachmentInputs[i].storedPath` with each attachment's resolved
 * on-disk path (used by the caller for path annotations + the
 * `attachmentStoredPaths` metadata). When no attachment links successfully the
 * row keeps its text-only content untouched.
 */
export function linkUserAttachmentsAndWriteReferences(
  messageId: string,
  textContent: string,
  attachmentInputs: MessageAttachmentInput[],
): void {
  const refs: AttachmentReferenceInput[] = [];
  for (let i = 0; i < attachmentInputs.length; i++) {
    const a = attachmentInputs[i];
    try {
      let finalId: string | undefined;
      // Pre-uploaded (already in the store, e.g. file-backed) attachment: link
      // the existing row directly without re-uploading.
      if (a.id && attachmentExists(a.id)) {
        finalId = linkAttachmentToMessage(messageId, a.id, i);
        a.storedPath = getFilePathForAttachment(finalId) ?? undefined;
      } else if (a.data) {
        const validation = validateAttachmentUpload(a.filename, a.mimeType);
        if (!validation.ok) {
          log.warn(
            { filename: a.filename, error: validation.error },
            "Skipping user attachment indexing: validation failed",
          );
          continue;
        }
        const stored = attachInlineAttachmentToMessage(
          messageId,
          i,
          a.filename,
          a.mimeType,
          a.data,
          { sourcePath: a.filePath, normalizeImage: true },
        );
        finalId = stored.id;
        a.storedPath = stored.filePath;
      } else {
        continue;
      }

      if (!finalId) continue;
      // The linked row is the source of truth for the stored mime/size/filename
      // (upload-time normalization may have rewritten e.g. HEIC → JPEG). Read
      // metadata only — no file hydration.
      const row = getAttachmentById(finalId);
      refs.push({
        attachmentId: finalId,
        filename: row?.originalFilename ?? a.filename,
        mimeType: row?.mimeType ?? a.mimeType,
        sizeBytes: row?.sizeBytes ?? base64ByteLength(a.data),
        data: a.data || undefined,
        extractedText: a.extractedText,
      });
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

  if (refs.length === 0) return;
  const refContent = [
    ...createUserMessage(textContent, []).content,
    ...attachmentsToReferenceBlocks(refs),
  ];
  updateMessageContent(messageId, JSON.stringify(refContent));
}

/**
 * Persist a user-message row whose attachment media is stored as workspace
 * references rather than inline base64. Inserts the row with text-only content,
 * then links each attachment and rewrites the row to carry `attachment_ref`
 * blocks. The single choke point every user-message persist site funnels
 * through, so no site writes base64 media into `messages.content`.
 *
 * `attachmentInputs` is mutated in place (each gets its resolved `storedPath`)
 * so callers can build path annotations / `attachmentStoredPaths` metadata from
 * it after this returns.
 */
export async function persistUserMessageRow(params: {
  conversationId: string;
  content: string;
  displayContent?: string;
  attachmentInputs: MessageAttachmentInput[];
  metadata?: Record<string, unknown>;
  clientMessageId?: string;
  id?: string;
}): Promise<Awaited<ReturnType<typeof addMessage>>> {
  const text =
    params.displayContent !== undefined
      ? params.displayContent
      : params.content;
  const inserted = await addMessage(
    params.conversationId,
    "user",
    serializePersistedUserTextContent(text),
    {
      ...(params.metadata ? { metadata: params.metadata } : {}),
      ...(params.clientMessageId
        ? { clientMessageId: params.clientMessageId }
        : {}),
      ...(params.id ? { id: params.id } : {}),
    },
  );
  if (!inserted.deduplicated && params.attachmentInputs.length > 0) {
    linkUserAttachmentsAndWriteReferences(
      inserted.id,
      text,
      params.attachmentInputs,
    );
  }
  return inserted;
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

/**
 * Build the Slack metadata envelope persisted under the `slackMeta` key on a
 * user message's `metadata` JSON. Returns `null` (do not include the key) when
 * the turn is not Slack-originated or the channel ingress did not supply
 * Slack-specific metadata.
 *
 * The conversation is the source of truth for the inbound channel for this
 * turn — `userMessageChannel` is set by `Server.processMessage` from
 * `transport.channelId`. Guarding on this ensures non-Slack flows (telegram,
 * voice, etc.) never get a `slackMeta` key even if a stale plumbing field
 * leaks through.
 */
export function buildSlackMetaForPersistence(params: {
  slackInbound: unknown;
  turnChannel: string | undefined;
}): string | null {
  if (params.turnChannel !== "slack") {
    return null;
  }
  const inbound = params.slackInbound;
  if (
    inbound === null ||
    typeof inbound !== "object" ||
    Array.isArray(inbound)
  ) {
    return null;
  }
  const candidate = inbound as Partial<SlackInboundMessageMetadata>;
  if (
    typeof candidate.channelId !== "string" ||
    !candidate.channelId ||
    typeof candidate.channelTs !== "string" ||
    !candidate.channelTs
  ) {
    return null;
  }
  const slackMeta: SlackMessageMetadata = {
    source: "slack",
    channelId: candidate.channelId,
    ...(candidate.channelName ? { channelName: candidate.channelName } : {}),
    channelTs: candidate.channelTs,
    eventKind: "message",
    ...(candidate.threadTs ? { threadTs: candidate.threadTs } : {}),
    ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
    ...(candidate.actorExternalUserId
      ? { actorExternalUserId: candidate.actorExternalUserId }
      : {}),
    ...buildSlackTimezoneMetadata(candidate),
  };
  return writeSlackMetadata(slackMeta);
}

// ── EnqueueMessageOptions ────────────────────────────────────────────

/** Options for `enqueueMessage`. Only `content` is required; everything
 *  else has a sensible default or is genuinely optional. */
export interface EnqueueMessageOptions {
  content: string;
  attachments?: UserMessageAttachment[];
  onEvent?: (msg: ServerMessage) => void;
  requestId?: string;
  activeSurfaceId?: string;
  currentPage?: string;
  metadata?: Record<string, unknown>;
  isInteractive?: boolean;
  displayContent?: string;
  transport?: ConversationTransportMetadata;
  clientMessageId?: string;
  /** JWT-verified requester principal captured for queued host-proxy routing. */
  sourceActorPrincipalId?: string;
  /** Auth context snapshot captured for queued turn-scoped authorization. */
  authContext?: AuthContext;
}

// ── enqueueMessage ───────────────────────────────────────────────────

export function enqueueMessage(
  ctx: MessagingConversationContext,
  options: EnqueueMessageOptions,
): { queued: boolean; requestId: string; rejected?: boolean } {
  const {
    content,
    attachments = [],
    onEvent,
    requestId = crypto.randomUUID(),
    activeSurfaceId,
    currentPage,
    metadata,
    isInteractive,
    displayContent,
    transport,
    clientMessageId,
    authContext,
  } = options;
  const queuedAuthContext =
    authContext ?? ctx.currentTurnAuthContext ?? ctx.authContext;
  const sourceActorPrincipalId =
    options.sourceActorPrincipalId ??
    ctx.currentTurnSourceActorPrincipalId ??
    queuedAuthContext?.actorPrincipalId;

  if (!ctx.isProcessing()) {
    return { queued: false, requestId };
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
    onEvent: onEvent ?? (() => {}),
    activeSurfaceId,
    currentPage,
    metadata,
    turnChannelContext,
    turnInterfaceContext,
    isInteractive,
    sourceActorPrincipalId,
    authContext: queuedAuthContext,
    transport,
    displayContent,
    sentAt: Date.now(),
    clientMessageId,
  });
  if (!accepted) {
    onEvent?.({
      type: "error",
      conversationId: ctx.conversationId,
      message:
        "The assistant is busy and cannot accept more messages right now. Please try again shortly.",
      category: "queue_full",
    });
    return { queued: false, requestId, rejected: true };
  }
  return { queued: true, requestId };
}

// ── PersistMessageOptions ────────────────────────────────────────────

/** Shared options for `persistUserMessage` and `persistQueuedMessageBody`. */
export interface PersistMessageOptions {
  content: string;
  attachments?: UserMessageAttachment[];
  requestId?: string;
  metadata?: Record<string, unknown>;
  displayContent?: string;
  clientMessageId?: string;
}

// ── persistUserMessage ───────────────────────────────────────────────

export async function persistUserMessage(
  ctx: MessagingConversationContext,
  options: PersistMessageOptions,
): Promise<{ id: string; deduplicated: boolean }> {
  const { content, attachments = [] } = options;

  if (ctx.isProcessing()) {
    throw new Error("Conversation is already processing a message");
  }

  if (!content.trim() && attachments.length === 0) {
    throw new Error("Message content or attachments are required");
  }

  const reqId = options.requestId ?? uuid();
  ctx.currentRequestId = reqId;
  ctx.abortController = new AbortController();

  try {
    // `setProcessing(true)` persists the flag and can throw (e.g.
    // SQLITE_BUSY). Keeping it inside the try ensures a failure here unwinds
    // the request-id/abort bookkeeping below rather than stranding it.
    ctx.setProcessing(true);
    const result = await persistQueuedMessageBody(ctx, {
      ...options,
      attachments,
      requestId: reqId,
    });
    if (result.deduplicated) {
      ctx.setProcessing(false);
      ctx.abortController = null;
      ctx.currentRequestId = undefined;
    }
    return result;
  } catch (err) {
    // Clear the flag, but never let a clear failure mask the original error
    // or skip the bookkeeping reset. `setProcessing` reverts its own
    // in-memory flag when its persist throws, so the conversation is left
    // consistent either way.
    try {
      ctx.setProcessing(false);
    } catch (clearErr) {
      log.error(
        { err: clearErr, conversationId: ctx.conversationId },
        "Failed to clear processing flag after persistUserMessage failure",
      );
    }
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
  options: PersistMessageOptions,
): Promise<{ id: string; deduplicated: boolean }> {
  const {
    content,
    attachments = [],
    requestId = uuid(),
    metadata,
    displayContent,
    clientMessageId,
  } = options;
  const attachmentInputs: MessageAttachmentInput[] = attachments.map(
    (attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      data: attachment.data,
      extractedText: attachment.extractedText,
      filePath: attachment.filePath,
    }),
  );
  const cleanMessage = createUserMessage(content, attachmentInputs);
  let pushedToHistory = false;

  try {
    const turnCtx =
      extractTurnChannelContext(metadata) ?? ctx.getTurnChannelContext();
    const turnIfCtx =
      extractTurnInterfaceContext(metadata) ?? ctx.getTurnInterfaceContext();
    const provenance = provenanceFromTrustContext(ctx.trustContext);
    const imageSourcePaths = extractImageSourcePaths(attachments);

    // Strip the transient `slackInbound` carrier key from the persisted
    // metadata — it's an in-memory plumbing field, not a stored column value.
    // The caller-supplied metadata may include it (channel ingress threads it
    // through `Server.processMessage`); we materialize it into the typed
    // `slackMeta` sub-key below when the turn channel is Slack.
    const { slackInbound: rawSlackInbound, ...metadataWithoutSlackInbound } =
      (metadata ?? {}) as Record<string, unknown> & {
        slackInbound?: SlackInboundMessageMetadata;
      };
    const slackMeta = buildSlackMetaForPersistence({
      slackInbound: rawSlackInbound,
      turnChannel: turnCtx?.userMessageChannel,
    });

    // Client attribution for turn telemetry, stored under the `client`
    // metadata bag which `turn-events-store` forwards onto
    // `TurnTelemetryEvent.client`. The bag merges two sources per key:
    // caller-supplied `client` metadata (e.g. the sanitized browser/OS/
    // version headers read by `handleSendMessage`) wins, and the
    // transport-reported OS (validated through `parseClientOs`) fills in
    // `os` when the caller didn't supply one — so header-less paths (CLI,
    // channel ingress) keep their OS attribution.
    const clientOs = parseClientOs(ctx.clientOs);
    const callerClient =
      metadataWithoutSlackInbound.client != null &&
      typeof metadataWithoutSlackInbound.client === "object"
        ? (metadataWithoutSlackInbound.client as Record<string, unknown>)
        : null;
    const clientEntries = {
      ...(clientOs ? { os: clientOs } : {}),
      ...(callerClient ?? {}),
    };
    const clientBag =
      Object.keys(clientEntries).length > 0 ? { client: clientEntries } : {};

    const mergedMetadata = {
      ...metadataWithoutSlackInbound,
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
      ...clientBag,
      ...(imageSourcePaths ? { imageSourcePaths } : {}),
      ...(slackMeta ? { slackMeta } : {}),
    };

    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message
    // after restart. The in-memory userMessage (sent to the LLM) still uses
    // the stripped content. Attachment media is stored as workspace references
    // (not inline base64) and its bytes are resolved at the provider boundary
    // — see persistUserMessageRow / resolveMediaReferences.
    const persistedUserMessage = await persistUserMessageRow({
      conversationId: ctx.conversationId,
      content,
      ...(displayContent !== undefined ? { displayContent } : {}),
      attachmentInputs,
      metadata: mergedMetadata,
      ...(clientMessageId ? { clientMessageId } : {}),
      id: requestId,
    });

    if (persistedUserMessage.deduplicated) {
      return { id: persistedUserMessage.id, deduplicated: true };
    }

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

    // Persist the resolved paths so history reloads can rebuild the same
    // annotation block the in-memory message carries below.
    const attachmentStoredPaths =
      extractAttachmentStoredPaths(attachmentInputs);
    if (attachmentStoredPaths) {
      updateMessageMetadata(persistedUserMessage.id, { attachmentStoredPaths });
    }

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
    pushedToHistory = true;

    // Sync the persisted user message (with attachments) to the disk view
    const conv = getConversation(ctx.conversationId);
    if (conv) {
      syncMessageToDisk(
        ctx.conversationId,
        persistedUserMessage.id,
        conv.createdAt,
      );
    }

    return { id: persistedUserMessage.id, deduplicated: false };
  } catch (err) {
    if (pushedToHistory) {
      ctx.messages.pop();
    }
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
