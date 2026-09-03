/**
 * Conversation messaging methods: enqueue, persistUserMessage,
 * redirectToSecurePrompt, and queue/confirmation helpers.
 *
 * Extracted from Conversation to keep the class focused on coordination.
 */

import { v7 as uuidv7 } from "uuid";

import {
  type AttachmentReferenceInput,
  attachmentsToContentBlocks,
  attachmentsToReferenceBlocks,
  enrichMessageWithSourcePaths,
  type MessageAttachmentInput,
} from "../agent/attachments.js";
import { optimizeImageForTransport } from "../agent/image-optimize.js";
import type { AssistantEvent } from "../api/index.js";
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
  type ProviderMessageMetadata,
  providerMessageMetadataSchema,
} from "../messaging/provider-message-metadata.js";
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
  deleteOrphanAttachments,
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
  isSuppressedQueuedMessage,
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
import { SIGHT_FRAME_ATTACHMENT_IDS_KEY } from "../persistence/conversation-types.js";
import {
  attachmentIdFragment,
  type ContentBlock,
  type Message,
} from "../providers/types.js";
import type { AuthContext } from "../runtime/auth/types.js";
import { getLogger } from "../util/logger.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import type { SlackInboundMessageMetadata } from "./handlers/shared.js";
import type { UserMessageAttachment } from "./message-protocol.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";
import {
  assembleUserContentBlocks,
  offloadLinkPlan,
  offloadOversizedText,
  type PortOversizedContext,
} from "./port-oversized-content.js";
import type { TrustContext } from "./trust-context-types.js";
import { restingTrust } from "./trust-context-types.js";
import { postUnsendableImageNotice } from "./unsendable-image-notice.js";

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
    if (!mapped) {
      continue;
    }
    mappedTargets.set(`${mapped.service}:${mapped.field}`, mapped);
  }
  if (mappedTargets.size === 1) {
    return mappedTargets.values().next().value!;
  }

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
  acquireProcessingFenced(): Promise<number | null>;
  releaseProcessing(owner: number): boolean;
  abortController: AbortController | null;
  currentRequestId?: string;
  readonly queue: MessageQueue;
  trustContext?: TrustContext;
  authContext?: AuthContext;
  currentTurnAuthContext?: AuthContext;
  currentTurnSourceActorPrincipalId?: string;
  /**
   * OS surface reported by the connected client, re-applied from transport
   * metadata on every inbound message.
   * Persisted under `metadata.client.os` so turn telemetry can attribute the
   * real platform. The transport `interfaceId` is "web" for browser, mobile,
   * and desktop apps because they share the web renderer.
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
export async function serializePersistedUserMessageContent(
  content: string,
  displayContent: string | undefined,
  attachments: MessageAttachmentInput[],
): Promise<string> {
  const attachmentBlocks = await attachmentsToContentBlocks(attachments);
  return serializeUserContentBlocks(content, displayContent, attachmentBlocks);
}

/**
 * Pixel dimensions to record on an image reference. The model receives the
 * transport-optimized image (`resolveMediaReferences` applies the same
 * optimization at send time), so we hint the optimized dimensions rather than
 * the stored original — keeping the per-turn token estimate accurate without a
 * disk read on the hot path.
 */
async function computeReferenceImageDimensions(
  attachmentId: string,
  mediaType: string,
): Promise<{ width: number; height: number } | null> {
  const bytes = getAttachmentContent(attachmentId);
  if (!bytes) {
    return null;
  }
  const optimized = await optimizeImageForTransport(
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
async function materializeUserAttachment(
  conversationId: string,
  conversationCreatedAt: number,
  a: MessageAttachmentInput,
): Promise<MaterializeOutcome> {
  try {
    if (a.id && attachmentExists(a.id)) {
      const stored = scopeAttachmentToMessageConversation(
        conversationId,
        conversationCreatedAt,
        a.id,
      );
      return stored ? { kind: "stored", stored } : { kind: "transient" };
    }
    if (!a.data) {
      return { kind: "rejected" };
    }
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
      stored: await createInlineAttachment(
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
async function referenceBlockForAttachment(
  a: MessageAttachmentInput,
  stored: { id: string; mimeType: string; sizeBytes: number },
): Promise<ContentBlock> {
  const ref: AttachmentReferenceInput = {
    attachmentId: stored.id,
    filename: a.filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    extractedText: a.extractedText,
  };
  if (stored.mimeType.toLowerCase().startsWith("image/")) {
    const dims = await computeReferenceImageDimensions(
      stored.id,
      stored.mimeType,
    );
    if (dims) {
      ref.width = dims.width;
      ref.height = dims.height;
    }
  }
  return attachmentsToReferenceBlocks([ref])[0]!;
}

/** Inline base64 fallback block for an attachment that could not be stored as
 * a reference, so the upload survives a reload. Null when there are no bytes. */
async function inlineBlockForAttachment(
  a: MessageAttachmentInput,
): Promise<ContentBlock | null> {
  if (!a.data) {
    return null;
  }
  return (await attachmentsToContentBlocks([a]))[0] ?? null;
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
async function prepareUserAttachmentReferences(
  conversationId: string,
  conversationCreatedAt: number,
  attachments: MessageAttachmentInput[],
): Promise<PreparedUserAttachment[]> {
  const prepared: PreparedUserAttachment[] = [];
  // Rows this call brought into being, tracked as they are made rather than
  // read back off `prepared`: building a reference block is awaited between
  // creating the row and recording it, so a throw there leaves a row nothing
  // else knows about. The caller only ever sees a returned array, so a throw
  // out of here makes this the one place that can still give them up.
  const created: string[] = [];
  try {
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      const outcome = await materializeUserAttachment(
        conversationId,
        conversationCreatedAt,
        a,
      );
      if (outcome.kind === "stored") {
        if (outcome.stored.id !== a.id) {
          created.push(outcome.stored.id);
        }
        prepared.push({
          position: i,
          block: await referenceBlockForAttachment(a, outcome.stored),
          link: { attachmentId: outcome.stored.id },
        });
        continue;
      }
      if (outcome.kind === "rejected") {
        continue;
      }
      // transient: keep the upload by inlining its bytes (dropped only when the
      // recoverable failure left us with no bytes to inline).
      const inline = await inlineBlockForAttachment(a);
      if (inline) {
        prepared.push({ position: i, block: inline });
      } else {
        log.warn(
          { filename: a.filename },
          "Dropping user attachment: store write failed and no inline bytes",
        );
      }
    }
  } catch (err) {
    discardAttemptAttachments(created);
    throw err;
  }
  return prepared;
}

/**
 * Give up attachment rows a failed persist attempt created for itself.
 *
 * Conversation scoping CLONES an attachment already linked to another
 * conversation, and an inline upload creates a fresh row under an id of its
 * own. Either way the row is an artifact of this attempt that nothing else can
 * reach: no message names it, and the caller still holds the id it sent or the
 * bytes behind it. An attempt that dies before its message row exists has to
 * take those with it, or the row and its copied file stay for good.
 *
 * Never the id the caller handed in. When materialization stored the
 * attachment under that same id, the row IS the caller's upload, and deleting
 * it would break the retry they are about to make.
 *
 * Routed through {@link deleteOrphanAttachments} so link-awareness stays the
 * backstop, and swallowed on failure: cleaning up must never mask the error
 * that caused it.
 */
function discardAttemptAttachments(attachmentIds: string[]): string[] {
  if (attachmentIds.length === 0) {
    return [];
  }
  try {
    deleteOrphanAttachments(attachmentIds);
    return [];
  } catch (err) {
    log.warn(
      { err, attachmentIds },
      "Could not discard the attachments of a failed persist attempt",
    );
    return attachmentIds;
  }
}

/**
 * Materialized ids that differ from the id their input arrived with, which is
 * what separates a row this attempt made from the caller's own upload.
 */
function attemptCreatedAttachmentIds(
  attachmentInputs: MessageAttachmentInput[],
  prepared: PreparedUserAttachment[],
): string[] {
  const created: string[] = [];
  for (const p of prepared) {
    if (!p.link) {
      continue;
    }
    if (p.link.attachmentId !== attachmentInputs[p.position]?.id) {
      created.push(p.link.attachmentId);
    }
  }
  return created;
}

/** One requested camera frame: the id the caller held, and what was stored. */
interface SightFrameEntry {
  inputId: string;
  storedId: string;
}

/**
 * Pair each requested ambient camera frame with the id its persisted block is
 * attributable by, walking every materialized attachment back to the input it
 * came from.
 *
 * Which id that is depends on how the attachment landed. A stored one is named
 * by its linked row, which is also what its `workspace_ref` block carries. One
 * that fell back to inline base64 has no row, and its block carries the
 * caller's own id on `_attachmentId`, so that is the id to name: retention
 * reads both shapes through `mediaBlockAttachmentId`, and an inline frame is
 * the heaviest thing in every later request precisely because its bytes are in
 * the row.
 */
function requestedSightFrameEntries(
  requestedIds: readonly string[] | undefined,
  attachmentInputs: MessageAttachmentInput[],
  prepared: PreparedUserAttachment[],
): SightFrameEntry[] {
  if (!requestedIds || requestedIds.length === 0) {
    return [];
  }
  const requested = new Set(requestedIds);
  const entries: SightFrameEntry[] = [];
  for (const p of prepared) {
    const inputId = attachmentInputs[p.position]?.id;
    if (inputId === undefined || !requested.has(inputId)) {
      continue;
    }
    entries.push({
      inputId,
      storedId: p.link ? p.link.attachmentId : inputId,
    });
  }
  return entries;
}

/**
 * The ids to tag the row with.
 *
 * Exactly one id per frame, never both. A stored attachment's pre-clone id
 * belongs to a DIFFERENT conversation's row, so naming it as well would mark
 * that attachment as an ambient frame if it ever entered this lineage and stub
 * an image someone deliberately attached. That is what separates this from a
 * fork's widened tag (`widenForkSightFrameTags`), where the two ids are two
 * names for the same image.
 */
function sightFrameTagIds(entries: SightFrameEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.storedId))];
}

/**
 * Frames whose stored id differs from the one the caller handed in, by the
 * caller's id. Empty unless conversation scoping cloned a row.
 */
function sightFrameBlockRenames(
  entries: SightFrameEntry[],
): Map<string, string> {
  return new Map(
    entries
      .filter((entry) => entry.storedId !== entry.inputId)
      .map((entry) => [entry.inputId, entry.storedId]),
  );
}

/**
 * Point an inline media block at the id its attachment was stored under.
 *
 * Only the inline shape is restamped. A `workspace_ref` names its row inside
 * `source`, which materialization already filled with the stored id, so there
 * is nothing to correct and rewriting `_attachmentId` alone would leave the two
 * halves disagreeing.
 */
function restampInlineAttachmentId(
  block: ContentBlock,
  renames: ReadonlyMap<string, string>,
): ContentBlock {
  if (block.type !== "image" && block.type !== "file") {
    return block;
  }
  if (block.source.type === "workspace_ref") {
    return block;
  }
  const renamed =
    block._attachmentId === undefined
      ? undefined
      : renames.get(block._attachmentId);
  if (renamed === undefined) {
    return block;
  }
  return { ...block, ...attachmentIdFragment(renamed) };
}

/**
 * Rewrite the live message's camera-frame blocks to the ids their rows were
 * stored under.
 *
 * The in-memory message is built from the attachments the caller handed in, so
 * its blocks name the ids the caller held while the tag names what
 * materialization stored. Those differ whenever conversation scoping cloned a
 * row, and retention walking the live history would then find no frame to age:
 * the tag matches nothing until a reload rebuilds the blocks from the persisted
 * content. Restamping is what makes the array a turn actually sends agree with
 * the tag, so a cloned frame is bounded on the turn that created it rather than
 * only after a restart.
 *
 * Matched by id, never by position: `attachmentsToContentBlocks` emits nothing
 * for an attachment it cannot turn into a block, so positions do not line up.
 */
function restampInlineAttachmentIds(
  message: Message,
  renames: ReadonlyMap<string, string>,
): Message {
  if (renames.size === 0) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((block) =>
      restampInlineAttachmentId(block, renames),
    ),
  };
}

function extractTurnChannelContext(
  metadata?: Record<string, unknown>,
): TurnChannelContext | null {
  if (!metadata) {
    return null;
  }
  const userMessageChannel = parseChannelId(metadata.userMessageChannel);
  const assistantMessageChannel = parseChannelId(
    metadata.assistantMessageChannel,
  );
  if (!userMessageChannel || !assistantMessageChannel) {
    return null;
  }
  return { userMessageChannel, assistantMessageChannel };
}

function extractTurnInterfaceContext(
  metadata?: Record<string, unknown>,
): TurnInterfaceContext | null {
  if (!metadata) {
    return null;
  }
  const userMessageInterface = parseInterfaceId(metadata.userMessageInterface);
  const assistantMessageInterface = parseInterfaceId(
    metadata.assistantMessageInterface,
  );
  if (!userMessageInterface || !assistantMessageInterface) {
    return null;
  }
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

/**
 * Build the neutral channel envelope persisted under the `providerMeta` key
 * on a user message's `metadata` JSON, the non-Slack counterpart of
 * {@link buildSlackMetaForPersistence}. Returns `null` (do not include the
 * key) when the turn channel does not match the envelope's own `source`, so
 * a stale plumbing field can never tag a row with another channel's
 * identity. Slack turns also return `null`: Slack still writes `slackMeta`,
 * which `readProviderMetadata` maps onto the neutral shape on read, and a
 * `providerMeta` key on a Slack row would shadow that richer envelope.
 *
 * TRANSITIONAL: the Slack exclusion exists only while Slack writes its own
 * envelope; do not extend it.
 */
export function buildProviderMetaForPersistence(params: {
  channelInbound: ProviderMessageMetadata | undefined;
  turnChannel: string | undefined;
}): string | null {
  const inbound = params.channelInbound;
  if (!inbound) {
    return null;
  }
  if (params.turnChannel !== inbound.source || inbound.source === "slack") {
    return null;
  }
  const parsed = providerMessageMetadataSchema.safeParse(inbound);
  if (!parsed.success) {
    return null;
  }
  return JSON.stringify(parsed.data);
}

// ── EnqueueMessageOptions ────────────────────────────────────────────

/** Options for `enqueueMessage`. Only `content` is required; everything
 *  else has a sensible default or is genuinely optional. */
export interface EnqueueMessageOptions {
  content: string;
  attachments?: UserMessageAttachment[];
  onEvent?: (msg: AssistantEvent) => void;
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
  /**
   * Sender's trust, for the drain to run this message under. Defaults to the
   * conversation's trust at enqueue time, which the sending route has just
   * set to this sender.
   */
  trustContext?: TrustContext;
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
    requestId = uuidv7(),
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
  // Deliberately not falling back to `currentTurnTrustContext`: that is the
  // in-flight turn's actor, which is precisely who this message is not from.
  const queuedTrustContext = options.trustContext ?? ctx.trustContext;

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
    trustContext: queuedTrustContext,
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
  // Ack the accepted enqueue on the sender's event sink. Emitting here,
  // rather than at each ingress call site, is what guarantees every path
  // that queues a person's prompt (HTTP send, surface actions, CLI signal)
  // surfaces the queued row live. Rows with no client-visible counterpart —
  // hidden sends and daemon-injected notifications (subagent/ACP/wake) — are
  // suppressed from the transcript at every stage, including this ack, and
  // `position` counts visible items only: both mirror the list-messages
  // queued-snapshot filter so a live ack and a cold reload render the same
  // row at the same position.
  if (!isSuppressedQueuedMessage(metadata)) {
    const position = ctx.queue
      .snapshot()
      .filter((item) => !isSuppressedQueuedMessage(item.metadata)).length;
    onEvent?.({
      type: "message_queued",
      conversationId: ctx.conversationId,
      requestId,
      position,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
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
  /**
   * Trust to attribute the stored row to. Queue drains pass the sender's
   * captured trust so persisted provenance names the same actor the turn
   * executes as; the conversation slot may by then hold someone else.
   * Defaults to the conversation's trust, which is correct for callers
   * persisting a message the current actor just sent.
   */
  trustContext?: TrustContext;
  /**
   * Persist the row without indexing it (no memory segments, embeddings, or
   * lexical-index entry). For machine-authored prompts that must not enter
   * memory or search; see `ProcessMessageOptions.skipUserMessageIndexing`.
   */
  skipIndexing?: boolean;
  /**
   * True when this turn was auto-sent on the user's behalf rather than typed
   * by them: onboarding research prompts, the personality `<system-message>`,
   * research corrections, hidden kickoff greetings, the legacy pre-chat
   * bootstrap, and `[User action on ...]` surface synthetics.
   *
   * Stamped onto `messages.metadata.scripted` and forwarded to
   * `TurnTelemetryEvent.scripted`, where activation metrics exclude it. This
   * is the consent-independent replacement for classifying turns by
   * text-matching their content in diagnostics-gated traces. That classifier
   * can only see owners who opted into diagnostics, so it silently counted
   * scripted turns as real messages for everyone else (ANT-10).
   *
   * Defaults to `false`: a daemon that knows about the field asserts "the user
   * typed this" for ordinary sends, which is what makes a user's activation
   * measurable. This is only safe because every auto-send path is marked at
   * its source. See the merged-metadata note below for the list.
   *
   * Callers persisting machine-authored content into a `standard` conversation
   * MUST pass `true`. A wrong `false` is trusted downstream and re-inflates
   * activation. (Machine-authored turns in `background` / `scheduled`
   * conversations are already excluded from activation by conversation type,
   * and the `assert_scripted_signals_agree` dbt test catches any straggler
   * whose text matches a known template.)
   *
   * May also be carried in the `metadata` bag, which is how queued sends
   * thread it: the queue round-trips `metadata`, not these options.
   */
  scripted?: boolean;
  /**
   * OS surface this row's own request or transport reported, threaded by the
   * ingress that built it (the send route's request body, a queued message's
   * `transport`). Stamps `metadata.clientOsFromRequest` when it matches the
   * `client.os` this row persists.
   *
   * `ctx.clientOs` alone is not that evidence: it is a live conversation
   * field only a transport-carrying message refreshes, so a transport-less
   * turn (surface action, signal ingress) inherits whatever an earlier send
   * left there. Omitting this option therefore reads as "inherited", which is
   * what a consumer that must not misattribute a turn to a surface needs.
   */
  requestClientOs?: string;
  /**
   * Which of `attachments`, by the id the caller holds, arrived as ambient
   * camera frames rather than files the user picked. Stamps
   * `SIGHT_FRAME_ATTACHMENT_IDS_KEY` on the persisted row, which is what the
   * retention pass reads to decide which images a later turn still sends in
   * full and which become timestamped stubs.
   *
   * Named through this option rather than written into `metadata` by the
   * caller because only the persist knows the id the row ends up linked to.
   * A pre-uploaded attachment already linked to another conversation is
   * CLONED into this one under a fresh id, and both the persisted content
   * block and the `message_attachments` row carry the clone. A tag composed
   * ahead of that names a row the retention pass can never match, and the
   * frame then rides every later request forever.
   *
   * The tag names whatever id the persisted block is attributable by: the
   * linked row's id for a materialized attachment, and the caller's own id
   * for one a recoverable store failure left as inline base64, which is the
   * id `attachmentsToContentBlocks` stamps on that block. The inline case is
   * the one that matters most, because such a block carries its full bytes in
   * `messages.content`, so the frame heaviest in every later request is
   * exactly the one retention has to be able to stub.
   */
  sightFrameAttachmentIds?: readonly string[];
  /**
   * Answered synchronously at the top of every insert attempt, immediately
   * before that attempt's statement. False aborts the persist with a
   * `MessageInsertPreconditionError` and inserts nothing.
   *
   * For a caller whose right to write can lapse while this persist runs.
   * Everything ahead of the insert (attachment materialization, content
   * building) is awaited, and the insert retries itself on contention across
   * an awaited backoff, so a caller that answered before calling has only
   * answered for the moment it called. Threaded down to the insert rather
   * than checked here, so each attempt asks for itself.
   */
  insertPrecondition?: () => boolean;
  /**
   * Told the ids this attempt materialized for itself and then could not
   * delete, so a caller that owns the cleanup can come back to them.
   *
   * An attachment already linked to another conversation is CLONED into this
   * one under a fresh id, and only this function knows that id. A caller
   * retrying the delete under the id it handed in would reclaim nothing: that
   * row is still linked where it came from, and the clone nobody names
   * survives every pass.
   */
  onUndiscardedAttachments?: (attachmentIds: readonly string[]) => void;
}

// ── persistUserMessage ───────────────────────────────────────────────

/**
 * Thrown by user-message persistence when the conversation's processing
 * lock is held. Callers (voice bridge retry, queue-drain requeue) match on
 * this exact string — keep it byte-stable.
 */
export const CONVERSATION_BUSY_MESSAGE =
  "Conversation is already processing a message";

/**
 * True when `err` is the {@link CONVERSATION_BUSY_MESSAGE} processing-lock
 * rejection thrown by {@link persistUserMessage} (and by
 * `prepareConversationForMessage`) while a turn is already in flight. Channel
 * ingress uses this to route a lock-contended turn to the retry sweep as a
 * retryable failure instead of letting it dead-letter as a fatal error.
 */
export function isConversationBusyError(err: unknown): boolean {
  return err instanceof Error && err.message === CONVERSATION_BUSY_MESSAGE;
}

export async function persistUserMessage(
  ctx: MessagingConversationContext,
  options: PersistMessageOptions,
): Promise<{ id: string; deduplicated: boolean }> {
  const { content, attachments = [] } = options;

  if (ctx.isProcessing()) {
    throw new Error(CONVERSATION_BUSY_MESSAGE);
  }

  if (!content.trim() && attachments.length === 0) {
    throw new Error("Message content or attachments are required");
  }

  const reqId = options.requestId ?? uuidv7();
  ctx.currentRequestId = reqId;
  ctx.abortController = new AbortController();

  let owner: number | null = null;
  try {
    // Taking the flag rather than setting it: the read and the take are one
    // step, so nothing can claim it in between, and the hold is released only
    // by the claim that took it. Its advisory mirror write is detached, which
    // is what closes the window a retry around a strict set used to open. That
    // retry re-ran the set after an awaited backoff, and the set reverted the
    // in-memory flag before rethrowing, so the conversation read idle for the
    // length of the sleep and anything waiting for idle could take the flag
    // while this turn was still starting.
    // Fenced: the flag is taken and its marker is durable before anything
    // this turn writes, because a reconnecting client and the out-of-process
    // retrospective worker read that marker to decide a turn is live. Null is
    // a conversation that belongs to someone else, whether it was already held
    // or was claimed away while the marker landed. A throw is the marker
    // refusing to persist, with the claim already given back.
    owner = await ctx.acquireProcessingFenced();
    if (owner === null) {
      throw new Error(CONVERSATION_BUSY_MESSAGE);
    }
    const result = await persistQueuedMessageBody(ctx, {
      ...options,
      attachments,
      requestId: reqId,
    });
    if (result.deduplicated) {
      ctx.releaseProcessing(owner);
      ctx.abortController = null;
      ctx.currentRequestId = undefined;
    }
    return result;
  } catch (err) {
    // Release this turn's own hold, but never let a failure there mask the
    // original error or skip the bookkeeping reset. A hold another caller
    // claimed since is left alone, and one this call never took is nothing to
    // release.
    try {
      if (owner !== null) {
        ctx.releaseProcessing(owner);
      }
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
    requestId = uuidv7(),
    metadata,
    displayContent,
    clientMessageId,
    skipIndexing,
    requestClientOs,
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
  let pushedToHistory = false;
  // Hoisted so the failure path can tell which rows this attempt made, and
  // whether its message ever landed. From the insert onward the persisted
  // content references those rows while no link yet protects them, which is
  // exactly the shape a link-aware delete reads as collectible, so the cleanup
  // must stop at the insert.
  let preparedAttachments: PreparedUserAttachment[] = [];
  let portedAttachmentIds: string[] = [];
  let messageInserted = false;

  try {
    const turnCtx =
      extractTurnChannelContext(metadata) ?? ctx.getTurnChannelContext();
    const turnIfCtx =
      extractTurnInterfaceContext(metadata) ?? ctx.getTurnInterfaceContext();
    const provenance = provenanceFromTrustContext(
      // Callers that own a turn pass the sender's trust; the fallback serves
      // ingress paths that persist before any per-turn stamp exists, where
      // the slot their own resolution just wrote is the right actor.
      options.trustContext ?? restingTrust(ctx),
    );
    const imageSourcePaths = extractImageSourcePaths(attachments);

    // Strip the transient `slackInbound` carrier key from the persisted
    // metadata — it's an in-memory plumbing field, not a stored column value.
    // The caller-supplied metadata may include it (channel ingress threads it
    // through `Server.processMessage`); we materialize it into the typed
    // `slackMeta` sub-key below when the turn channel is Slack.
    // `scripted` is pulled out of the raw bag alongside `slackInbound` so the
    // spread below can never re-introduce an unvalidated value. Letting a
    // non-boolean through would be worse than dropping it: sqlite stores it
    // verbatim, and `turn-events-store` narrows anything that isn't 1 to
    // `false`, turning a junk string into a confident "the user typed this".
    // `clientOsFromRequest` comes out for the same reason and a sharper one:
    // it is derived below from what this persist can actually see, and a bag
    // value surviving the spread would let a caller assert an origin the row
    // never reported.
    const {
      slackInbound: rawSlackInbound,
      channelInbound: rawChannelInbound,
      scripted: rawScriptedFromMetadata,
      clientOsFromRequest: _rawClientOsFromRequest,
      ...metadataWithoutSlackInbound
    } = (metadata ?? {}) as Record<string, unknown> & {
      slackInbound?: SlackInboundMessageMetadata;
      channelInbound?: ProviderMessageMetadata;
      scripted?: unknown;
      clientOsFromRequest?: unknown;
    };
    const slackMeta = buildSlackMetaForPersistence({
      slackInbound: rawSlackInbound,
      turnChannel: turnCtx?.userMessageChannel,
    });
    const providerMeta = buildProviderMetaForPersistence({
      channelInbound: rawChannelInbound,
      turnChannel: turnCtx?.userMessageChannel,
    });

    // See the `scripted` note on the merged metadata below. Only a real
    // boolean in the bag counts: a stray truthy string must not be read as a
    // scripted assertion.
    const scriptedFromMetadata =
      typeof rawScriptedFromMetadata === "boolean"
        ? rawScriptedFromMetadata
        : undefined;
    // `automated` (machine-authored, set by the messaging skill and the memory
    // skill-card) implies scripted: it is by definition not a turn the user
    // typed. Only a DEFAULT: an explicit `scripted` wins, so a caller can
    // mark an automated message as a real turn if that is ever right. Note the
    // two flags are not interchangeable in the other direction: `automated`
    // also suppresses memory extraction, so scripted onboarding turns that
    // should still be indexed must not be marked automated to get counted out.
    const scriptedFromAutomated =
      metadataWithoutSlackInbound.automated === true ? true : undefined;
    const resolvedScripted =
      options.scripted ??
      scriptedFromMetadata ??
      scriptedFromAutomated ??
      false;

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

    // Per-row evidence for the `client.os` stamped just above, kept as a
    // sibling of the bag so `TurnTelemetryEvent.client` stays exactly the
    // forwarded `$.client`. Set only when this row itself reported the OS:
    // through the caller's own client bag (the request's client-metadata
    // headers, round-tripped through the queue) or through this row's
    // transport, which `requestClientOs` carries. An inherited `ctx.clientOs`
    // names the surface of an EARLIER turn, so it leaves the marker off and a
    // consumer reading origin (the reply-push presence gate) treats the turn
    // as coming from somewhere unknown.
    const callerOs = callerClient?.os;
    const resolvedRequestClientOs = parseClientOs(requestClientOs);
    const clientOsFromRequest =
      (typeof callerOs === "string" && callerOs.length > 0) ||
      (resolvedRequestClientOs !== null &&
        resolvedRequestClientOs === clientOs);

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
      ...(clientOsFromRequest ? { clientOsFromRequest: true } : {}),
      ...(imageSourcePaths ? { imageSourcePaths } : {}),
      ...(slackMeta ? { slackMeta } : {}),
      ...(providerMeta ? { providerMeta } : {}),
      // Scripted-turn marker, forwarded by `turn-events-store` onto
      // `TurnTelemetryEvent.scripted`. Written LAST so it cannot be
      // half-overwritten by the raw metadata spread above.
      //
      // Resolved from the typed option first, then the metadata bag. The bag
      // is how queued sends carry it, since the queue round-trips `metadata`
      // but not `PersistMessageOptions` (same carrier as the `hidden` flag).
      //
      // Always stamped, including the `false` default: a daemon that knows
      // about the field asserts "the user typed this" for ordinary sends, and
      // that assertion is what makes a user's activation MEASURABLE
      // downstream. Absent would mean "unknown", which is strictly worse
      // information than a truthful false.
      //
      // Defaulting to false is only safe because every auto-send path is now
      // marked at its source: the web onboarding flows (research prompt,
      // kickoff, personality, corrections, legacy bootstrap), `[User action
      // on ...]` surface synthetics, and anything flagged `automated`. A new
      // auto-send path that forgets to mark itself lands here as a false and
      // is believed. The `assert_scripted_signals_agree` dbt test is the
      // backstop: it fires when a turn claiming `false` matches a known
      // scripted template.
      scripted: resolvedScripted,
    };

    // Materialize each attachment into an attachment-store row up front so the
    // persisted content can reference it by id instead of inlining base64. The
    // message link (message_attachments) is written after addMessage below,
    // once the message id exists.
    const conversationCreatedAt =
      getConversation(ctx.conversationId)?.createdAt ?? Date.now();
    preparedAttachments = await prepareUserAttachmentReferences(
      ctx.conversationId,
      conversationCreatedAt,
      attachmentInputs,
    );

    // The turn sees exactly what was persisted: an attachment rejected during
    // materialization is absent from both, so a file the store refused cannot
    // reach the model through the in-memory message.
    const sentAttachments = preparedAttachments.map(
      (p) => attachmentInputs[p.position],
    );
    const sightFrameEntries = requestedSightFrameEntries(
      options.sightFrameAttachmentIds,
      attachmentInputs,
      preparedAttachments,
    );
    const sightFrameRenames = sightFrameBlockRenames(sightFrameEntries);

    const portCtx: PortOversizedContext = {
      conversationId: ctx.conversationId,
      conversationCreatedAt,
    };
    const persistText = displayContent !== undefined ? displayContent : content;
    const persistOffload = await offloadOversizedText(persistText, portCtx);
    const liveOffload =
      persistText === content
        ? persistOffload
        : await offloadOversizedText(content, portCtx);
    const attachmentBlocks = preparedAttachments.map((p) => p.block);
    const persistBlocks = assembleUserContentBlocks(
      persistOffload.text,
      attachmentBlocks,
      persistOffload.fileBlock,
    );
    const liveBlocks = assembleUserContentBlocks(
      liveOffload.text,
      attachmentBlocks,
      liveOffload.fileBlock,
    );
    const offloadPlan = offloadLinkPlan(
      persistOffload.attachmentId,
      liveOffload.attachmentId,
    );
    portedAttachmentIds = offloadPlan.linkIds;

    // Workspace-ref blocks (including offloaded oversized text) so the live
    // turn matches persist: video and huge strings stay off the prompt.
    const cleanMessage = restampInlineAttachmentIds(
      { role: "user", content: liveBlocks },
      sightFrameRenames,
    );

    const contentToPersist = JSON.stringify(persistBlocks);
    // Composed here rather than with the rest of the metadata above, because
    // materialization is what decides the id each frame is stored under.
    const sightFrameIds = sightFrameTagIds(sightFrameEntries);
    const metadataToPersist =
      sightFrameIds.length > 0
        ? { ...mergedMetadata, [SIGHT_FRAME_ATTACHMENT_IDS_KEY]: sightFrameIds }
        : mergedMetadata;

    const persistedUserMessage = await addMessage(
      ctx.conversationId,
      "user",
      contentToPersist,
      {
        metadata: metadataToPersist,
        clientMessageId,
        id: requestId,
        ...(skipIndexing ? { skipIndexing: true } : {}),
        // Handed down rather than answered here: the insert retries itself on
        // contention, so the question belongs where each attempt can ask it.
        ...(options.insertPrecondition
          ? { insertPrecondition: options.insertPrecondition }
          : {}),
      },
    );
    messageInserted = true;

    if (persistedUserMessage.deduplicated) {
      discardAttemptAttachments(portedAttachmentIds);
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
    for (const [idx, p] of preparedAttachments.entries()) {
      if (!p.link) {
        continue;
      }
      try {
        const scopedAttachmentId = linkAttachmentToMessage(
          persistedUserMessage.id,
          p.link.attachmentId,
          p.position,
        );
        attachmentInputs[p.position].storedPath =
          getFilePathForAttachment(scopedAttachmentId) ?? undefined;
      } catch (err) {
        const inline = await inlineBlockForAttachment(
          attachmentInputs[p.position],
        );
        log.error(
          { attachmentId: p.link.attachmentId, err, repaired: inline != null },
          "Failed to link user attachment; repairing persisted content to inline",
        );
        if (inline) {
          repairedBlocks ??= preparedAttachments.map((pp) => pp.block);
          // Rebuilt from the caller's attachment, so it names the id the
          // caller held while the tag written above names the stored row.
          // Restamping keeps a repaired frame matchable by retention.
          repairedBlocks[idx] = restampInlineAttachmentId(
            inline,
            sightFrameRenames,
          );
        }
      }
    }
    if (repairedBlocks) {
      updateMessageContent(
        persistedUserMessage.id,
        JSON.stringify(
          assembleUserContentBlocks(
            persistOffload.text,
            repairedBlocks,
            persistOffload.fileBlock,
          ),
        ),
      );
    }

    let nextPortPosition =
      preparedAttachments.reduce((max, p) => Math.max(max, p.position), -1) + 1;
    for (const attachmentId of portedAttachmentIds) {
      try {
        const scopedId = linkAttachmentToMessage(
          persistedUserMessage.id,
          attachmentId,
          nextPortPosition,
        );
        nextPortPosition += 1;
        const storedPath = getFilePathForAttachment(scopedId) ?? undefined;
        // Display-only offloads stay linked (GC + persisted workspace_ref)
        // but must not be named on the model-facing list.
        if (
          offloadPlan.modelFacingIds.has(attachmentId) &&
          liveOffload.filename
        ) {
          sentAttachments.push({
            filename: liveOffload.filename,
            mimeType: "text/plain",
            data: "",
            storedPath,
          });
        }
      } catch (err) {
        log.error(
          { attachmentId, err },
          "Failed to link offloaded oversized content attachment",
        );
      }
    }

    // Same list enrichMessageWithSourcePaths sees, so history reload rebuilds
    // an identical annotation block (prefix-cache parity).
    const attachmentStoredPaths =
      extractAttachmentStoredPaths(sentAttachments);
    if (attachmentStoredPaths) {
      updateMessageMetadata(persistedUserMessage.id, { attachmentStoredPaths });
    }

    const llmMessage = enrichMessageWithSourcePaths(
      cleanMessage,
      sentAttachments,
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

    // Read after the content is final (including any link-failure repair), so
    // the notice describes the blocks the send boundary will actually see.
    const persistedImages = preparedAttachments.flatMap((p, idx) => {
      const block = repairedBlocks?.[idx] ?? p.block;
      if (block.type !== "image") {
        return [];
      }
      const { filename } = attachmentInputs[p.position];
      return [{ filename, source: block.source }];
    });
    await postUnsendableImageNotice(ctx.conversationId, persistedImages);

    return { id: persistedUserMessage.id, deduplicated: false };
  } catch (err) {
    if (pushedToHistory) {
      ctx.messages.pop();
    }
    if (!messageInserted) {
      const undiscarded = discardAttemptAttachments([
        ...attemptCreatedAttachmentIds(attachmentInputs, preparedAttachments),
        ...portedAttachmentIds,
      ]);
      if (undiscarded.length > 0) {
        options.onUndiscardedAttachments?.(undiscarded);
      }
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
      if (!result.value) {
        return;
      }

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
