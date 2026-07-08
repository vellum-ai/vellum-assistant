/**
 * Conversation messaging methods: enqueue, persistUserMessage,
 * redirectToSecurePrompt, and queue/confirmation helpers.
 *
 * Extracted from Conversation to keep the class focused on coordination.
 */

import { v4 as uuid } from "uuid";

import {
  type AttachmentReferenceInput,
  attachmentsToContentBlocks,
  attachmentsToReferenceBlocks,
  enrichMessageWithSourcePaths,
  type MessageAttachmentInput,
} from "../agent/attachments.js";
import { optimizeImageForTransport } from "../agent/image-optimize.js";
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
import { parseImageDimensions } from "../context/image-dimensions.js";
import {
  buildSlackTimezoneMetadata,
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import {
  attachmentExists,
  AttachmentUploadError,
  createInlineAttachment,
  getAttachmentContent,
  getFilePathForAttachment,
  linkAttachmentToMessage,
  scopeAttachmentToMessageConversation,
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
import type { ContentBlock, Message } from "../providers/types.js";
import type { AuthContext } from "../runtime/auth/types.js";
import { getLogger } from "../util/logger.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import type { SlackInboundMessageMetadata } from "./handlers/shared.js";
import type {
  ServerMessage,
  UserMessageAttachment,
} from "./message-protocol.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";
import type { TrustContext } from "./trust-context-types.js";

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

/**
 * Serialize a user message for `messages.content`: the message text (preferring
 * `displayContent`) followed by the given attachment content blocks. The upload
 * path builds `workspace_ref` (or inline-fallback) blocks and serializes them
 * here; {@link serializePersistedUserMessageContent} is the base64 entry point.
 */
function serializeUserContentBlocks(
  content: string,
  displayContent: string | undefined,
  attachmentBlocks: ContentBlock[],
): string {
  const text = displayContent !== undefined ? displayContent : content;
  const blocks: ContentBlock[] = [];
  if (text.trim().length > 0) {
    blocks.push({ type: "text", text });
  }
  blocks.push(...attachmentBlocks);
  return JSON.stringify(blocks);
}

/**
 * Serialize the user message as PERSISTED into `messages.content` for callers
 * that hold raw attachments (slash-command branches): the message text followed
 * by the attachments as inline base64 blocks. The regular upload path persists
 * `workspace_ref` blocks instead (see `persistQueuedMessageBody`).
 */
export function serializePersistedUserMessageContent(
  content: string,
  displayContent: string | undefined,
  attachments: MessageAttachmentInput[],
): string {
  return serializeUserContentBlocks(
    content,
    displayContent,
    attachmentsToContentBlocks(attachments),
  );
}

/**
 * Pixel dimensions to record on an image reference. The model receives the
 * transport-optimized image (`resolveMediaReferences` applies the same
 * optimization at send time), so we hint the optimized dimensions rather than
 * the stored original — keeping the per-turn token estimate accurate without a
 * disk read on the hot path.
 */
function computeReferenceImageDimensions(
  attachmentId: string,
  mediaType: string,
): { width: number; height: number } | null {
  const bytes = getAttachmentContent(attachmentId);
  if (!bytes) return null;
  const optimized = optimizeImageForTransport(
    bytes.toString("base64"),
    mediaType,
  );
  return parseImageDimensions(optimized.data, optimized.mediaType);
}

interface PreparedUserAttachment {
  position: number;
  /** The content block persisted for this attachment (a reference or, on a
   * materialization failure, an inline base64 fallback). */
  block: ContentBlock;
  /** Present only for a materialized reference block that still needs its
   * `message_attachments` GC link written once the message id exists. */
  link?: { attachmentId: string };
}

/**
 * Outcome of trying to materialize one attachment:
 * - `stored` — written to the attachment store; persist a reference.
 * - `rejected` — refused by validation or an upload-limit/format error; the
 *   attachment must NOT reach `messages.content` or the model turn.
 * - `transient` — a recoverable store-write failure (disk/DB); fall back to
 *   inline base64 so the upload survives even though the row could not be
 *   written.
 */
type MaterializeOutcome =
  | {
      kind: "stored";
      stored: { id: string; mimeType: string; sizeBytes: number };
    }
  | { kind: "rejected" }
  | { kind: "transient" };

/**
 * Materialize a single attachment into an attachment-store row. Validation and
 * upload-limit/format failures are `rejected` (dropped, matching the upload
 * endpoint's own rejection); only a recoverable store-write failure is
 * `transient` (inline fallback).
 */
function materializeUserAttachment(
  conversationId: string,
  conversationCreatedAt: number,
  a: MessageAttachmentInput,
): MaterializeOutcome {
  try {
    if (a.id && attachmentExists(a.id)) {
      const stored = scopeAttachmentToMessageConversation(
        conversationId,
        conversationCreatedAt,
        a.id,
      );
      return stored ? { kind: "stored", stored } : { kind: "transient" };
    }
    if (!a.data) return { kind: "rejected" };
    const validation = validateAttachmentUpload(a.filename, a.mimeType);
    if (!validation.ok) {
      log.warn(
        { filename: a.filename, error: validation.error },
        "Rejecting user attachment: failed validation",
      );
      return { kind: "rejected" };
    }
    return {
      kind: "stored",
      stored: createInlineAttachment(
        conversationId,
        conversationCreatedAt,
        a.filename,
        a.mimeType,
        a.data,
        { sourcePath: a.filePath, normalizeImage: true },
      ),
    };
  } catch (err) {
    if (err instanceof AttachmentUploadError) {
      // Invalid base64, over the size limit, unsupported format: the same
      // conditions the upload endpoint rejects. Drop rather than inline.
      log.warn(
        { filename: a.filename, error: err.message },
        "Rejecting user attachment: upload validation error",
      );
      return { kind: "rejected" };
    }
    log.error(
      { filename: a.filename, err },
      "Failed to store user attachment; persisting inline",
    );
    return { kind: "transient" };
  }
}

/** Build the `workspace_ref` content block for a materialized attachment. */
function referenceBlockForAttachment(
  a: MessageAttachmentInput,
  stored: { id: string; mimeType: string; sizeBytes: number },
): ContentBlock {
  const ref: AttachmentReferenceInput = {
    attachmentId: stored.id,
    filename: a.filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    extractedText: a.extractedText,
  };
  if (stored.mimeType.toLowerCase().startsWith("image/")) {
    const dims = computeReferenceImageDimensions(stored.id, stored.mimeType);
    if (dims) {
      ref.width = dims.width;
      ref.height = dims.height;
    }
  }
  return attachmentsToReferenceBlocks([ref])[0]!;
}

/** Inline base64 fallback block for an attachment that could not be stored as
 * a reference, so the upload survives a reload. Null when there are no bytes. */
function inlineBlockForAttachment(
  a: MessageAttachmentInput,
): ContentBlock | null {
  if (!a.data) return null;
  return attachmentsToContentBlocks([a])[0] ?? null;
}

/**
 * Materialize each user attachment into an attachment-store row BEFORE the
 * message content is serialized, so the content can reference it by id instead
 * of inlining base64. Pre-uploaded attachments are scoped into the
 * conversation; inline uploads create a new row now (rather than after
 * `addMessage`). Returns, per attachment, the persisted content block plus the
 * link info needed to write the `message_attachments` row once the message
 * exists. A recoverable store failure falls back to inline base64 so the upload
 * survives; a validation/upload rejection is dropped (never reaches content or
 * the model).
 */
function prepareUserAttachmentReferences(
  conversationId: string,
  conversationCreatedAt: number,
  attachments: MessageAttachmentInput[],
): PreparedUserAttachment[] {
  const prepared: PreparedUserAttachment[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const outcome = materializeUserAttachment(
      conversationId,
      conversationCreatedAt,
      a,
    );
    if (outcome.kind === "stored") {
      prepared.push({
        position: i,
        block: referenceBlockForAttachment(a, outcome.stored),
        link: { attachmentId: outcome.stored.id },
      });
      continue;
    }
    if (outcome.kind === "rejected") continue;
    // transient: keep the upload by inlining its bytes (dropped only when the
    // recoverable failure left us with no bytes to inline).
    const inline = inlineBlockForAttachment(a);
    if (inline) {
      prepared.push({ position: i, block: inline });
    } else {
      log.warn(
        { filename: a.filename },
        "Dropping user attachment: store write failed and no inline bytes",
      );
    }
  }
  return prepared;
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

    // Materialize each attachment into an attachment-store row up front so the
    // persisted content can reference it by id instead of inlining base64. The
    // message link (message_attachments) is written after addMessage below,
    // once the message id exists.
    const conversationCreatedAt =
      getConversation(ctx.conversationId)?.createdAt ?? Date.now();
    const preparedAttachments = prepareUserAttachmentReferences(
      ctx.conversationId,
      conversationCreatedAt,
      attachmentInputs,
    );

    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message
    // after restart. The in-memory userMessage (sent to the LLM) still uses
    // the stripped content.
    const contentToPersist = serializeUserContentBlocks(
      content,
      displayContent,
      preparedAttachments.map((p) => p.block),
    );
    const persistedUserMessage = await addMessage(
      ctx.conversationId,
      "user",
      contentToPersist,
      { metadata: mergedMetadata, clientMessageId, id: requestId },
    );

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

    // Link each materialized reference to the persisted message. The link row
    // is the GC anchor (an attachment with no link is collectible), and it
    // resolves the canonical stored path — name collisions in the conversation's
    // attachments/ dir get a -2/-3 suffix, so the stored path (not the original
    // filename) is the only reliable on-disk handle for the file.
    //
    // If a link fails, the persisted content still holds a `workspace_ref`
    // pointing at an unlinked (GC-eligible) row — a broken reference. Repair it
    // by rewriting that block to inline base64 so the upload survives even
    // though the store anchor was lost, then persist the corrected content.
    let repairedBlocks: ContentBlock[] | null = null;
    preparedAttachments.forEach((p, idx) => {
      if (!p.link) return;
      try {
        const scopedAttachmentId = linkAttachmentToMessage(
          persistedUserMessage.id,
          p.link.attachmentId,
          p.position,
        );
        attachmentInputs[p.position].storedPath =
          getFilePathForAttachment(scopedAttachmentId) ?? undefined;
      } catch (err) {
        const inline = inlineBlockForAttachment(attachmentInputs[p.position]);
        log.error(
          { attachmentId: p.link.attachmentId, err, repaired: inline != null },
          "Failed to link user attachment; repairing persisted content to inline",
        );
        if (inline) {
          repairedBlocks ??= preparedAttachments.map((pp) => pp.block);
          repairedBlocks[idx] = inline;
        }
      }
    });
    if (repairedBlocks) {
      updateMessageContent(
        persistedUserMessage.id,
        serializeUserContentBlocks(content, displayContent, repairedBlocks),
      );
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
