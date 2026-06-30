/**
 * Message operations: history retrieval, polling, sending, and attachments.
 *
 * The daemon's history-row wire contract is the canonical `ConversationMessage`
 * schema from `@vellumai/assistant-api`, consumed here alongside content
 * normalization helpers and the `postChatMessage` / `uploadChatAttachment` /
 * `deleteQueuedMessage` writes.
 */

import { captureError } from "@/lib/sentry/capture-error";
import type {
  ConversationContentBlock,
  ConversationMessage,
  ConversationMessageToolCall,
  ConversationSubagentNotification,
} from "@vellumai/assistant-api";
import { parseAttachmentSummariesFromContent } from "@/domains/chat/utils/parse-attachment-summaries";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  attachmentsPost,
  messagesGet,
  messagesPost,
  messagesQueuedByIdSteerPost,
  messagesQueuedByIdDelete,
} from "@/generated/daemon/sdk.gen";
import type {
  MessagesGetData,
  MessagesGetResponse,
  MessagesPostData,
} from "@/generated/daemon/types.gen";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import {
  normalizePreChatOnboardingContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import { persistPreChatOnboardingProfile } from "@/domains/onboarding/prechat-profile";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { pickConversationIdWireField } from "@/lib/backwards-compat/conversation-id-wire-field";
import { getEffectiveTimezone } from "@/utils/effective-timezone";
import { detectClientOs } from "@/runtime/platform-detection";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

/**
 * Subagent notification as carried by the web. The wire shape
 * (`ConversationSubagentNotification`) is enriched during history
 * reconstruction with the client-derived id of the parent assistant message
 * that spawned the subagent (see `history.ts`); those fields are not part of
 * the wire contract.
 */
export interface RuntimeSubagentNotification extends ConversationSubagentNotification {
  /** StableId of the parent assistant message that spawned this subagent. */
  parentMessageStableId?: string;
  /** Daemon UUID of the parent assistant message. Stable across reloads. */
  parentMessageId?: string;
}

export async function pollForResponse(
  assistantId: string,
  userMessageId: string,
  conversationId: string,
): Promise<ConversationMessage | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data, error, response } = await messagesGet({
      path: { assistant_id: assistantId },
      query: { conversationId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to poll for messages");

    if (!response.ok) {
      const msg = extractErrorMessage(
        error,
        response,
        "Failed to poll for messages",
      );
      throw new Error(msg);
    }

    const messages = data?.messages ?? [];

    // Only consider assistant messages that appear after our sent user
    // message in the list, establishing a causal boundary so delayed
    // replies from earlier sends cannot be mis-associated.
    const userMsgIndex = messages.findIndex((m) => m.id === userMessageId);
    if (userMsgIndex >= 0) {
      const afterSend = messages.slice(userMsgIndex + 1);
      const reply = afterSend.find((m) => m.role === "assistant");
      if (reply) {
        return reply;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

/**
 * Project a canonical wire tool call onto the `ChatMessageToolCall` rendered in
 * the transcript. The wire base already carries every shared field (`name`,
 * `input`, `result`, the risk/approval fields, the `risk*Options` ladders), so
 * we only layer the client-only live state: the stable `id`. The `id` is the
 * provider tool-use id the wire now carries — the same id the live
 * `tool_use_start` stream uses, so reconcile matches snapshot and stream tool
 * calls by it. We fall back to a positional synthesized id only for daemons
 * predating the wire `id` field. Execution `status` is not stored; it is
 * derived on demand from `isError`/`result`/`completedAt` via the predicates
 * in `tool-call-status.ts`.
 */
export function mapRuntimeToolCalls(
  toolCalls: ConversationMessageToolCall[],
  messageId: string,
): ChatMessageToolCall[] {
  return toolCalls.map((tc, idx) => {
    // Drop `confirmationDecision` from the spread and re-add it only when the
    // wire row actually carries one. A history row that omits it must not
    // materialize `confirmationDecision: undefined`, or reconciliation would
    // spread that over a live `"denied"`/`"timed_out"` decision set locally by
    // `confirmation-actions`.
    const { confirmationDecision, ...rest } = tc;
    return {
      ...rest,
      id: tc.id ?? `tool-history-${messageId}-${idx}`,
      ...(confirmationDecision !== undefined ? { confirmationDecision } : {}),
    };
  });
}

/**
 * Normalize a contentOrder entry from the server's string format
 * (e.g. "text:0", "tool:1", "surface:2") into the client's object format
 * ({ type, id }). Already-object entries are passed through unchanged.
 */
function normalizeContentOrderEntry(
  entry: unknown,
): { type: string; id: string } | null {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.type === "string" && typeof obj.id === "string") {
      return { type: obj.type, id: obj.id };
    }
  }
  if (typeof entry === "string") {
    const colonIdx = entry.indexOf(":");
    if (colonIdx > 0) {
      return { type: entry.slice(0, colonIdx), id: entry.slice(colonIdx + 1) };
    }
  }
  return null;
}

/**
 * Normalize a contentOrder array from the server, converting string-format
 * entries into the object format the client rendering code expects.
 */
export function normalizeContentOrder(
  raw: unknown[] | undefined,
): Array<{ type: string; id: string }> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const result: Array<{ type: string; id: string }> = [];
  for (const entry of raw) {
    const normalized = normalizeContentOrderEntry(entry);
    if (normalized) result.push(normalized);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Resolve a message's unified `contentBlocks` projection.
 *
 * The daemon emits `contentBlocks` directly from the model-native content
 * (`renderHistoryContent`) as the authoritative, single-ordered list of
 * text / thinking / tool_use / surface / attachment blocks. Any defined value
 * — including an empty array — is returned verbatim: the server having sent
 * the field at all means it is authoritative (an empty list is a genuinely
 * contentless message, not a missing projection), so the renderer consumes
 * the canonical wire shape with no client-side reshaping.
 *
 * The reconstruction path below exists solely for assistants versioned
 * `< 0.8.8`, which predate the projection and omit `contentBlocks` entirely.
 * Those ship only the positional
 * `contentOrder`/`textSegments`/`thinkingSegments`/`toolCalls`/`surfaces`/
 * `attachments` arrays, so we rebuild the same discriminated-union list from
 * them and the renderer always has a wire-shaped list regardless of daemon
 * version. The reconstruction mirrors the daemon's own builder: text segments
 * are stripped of their inlined `[File attachment]` summary lines (attachments
 * surface as `attachment` blocks, not text) and fully-consumed (empty) text
 * segments are dropped, so a reconstructed row is indistinguishable from a
 * daemon-provided one. It can be deleted once `< 0.8.8` assistants are no
 * longer supported.
 */
export function normalizeContentBlocks(
  m: ConversationMessage,
): ConversationContentBlock[] | undefined {
  if (m.contentBlocks !== undefined) {
    return m.contentBlocks;
  }

  const order = normalizeContentOrder(m.contentOrder);
  if (!order) return undefined;

  const blocks: ConversationContentBlock[] = [];
  for (const { type, id } of order) {
    const idx = Number.parseInt(id, 10);
    if (Number.isNaN(idx)) continue;
    switch (type) {
      case "text": {
        const raw = m.textSegments?.[idx];
        if (raw == null) break;
        const { cleanedContent } = parseAttachmentSummariesFromContent(raw);
        if (cleanedContent.trim().length > 0) {
          blocks.push({ type: "text", text: cleanedContent });
        }
        break;
      }
      case "thinking": {
        const thinking = m.thinkingSegments?.[idx];
        if (thinking != null) blocks.push({ type: "thinking", thinking });
        break;
      }
      case "tool":
      case "toolCall": {
        const toolCall = m.toolCalls?.[idx];
        if (toolCall) {
          // Mirror `mapRuntimeToolCalls`'s positional id synthesis so a
          // reconstructed tool_use block carries the same stable id the
          // positional `toolCalls` array does. Pre-0.8.8 wire tool calls omit
          // `id`; without this the block-native render path can't key them.
          blocks.push({
            type: "tool_use",
            toolCall: {
              ...toolCall,
              id: toolCall.id ?? `tool-history-${m.id}-${idx}`,
            },
          });
        }
        break;
      }
      case "surface": {
        const surface = m.surfaces?.[idx];
        if (surface) blocks.push({ type: "surface", surface });
        break;
      }
      case "attachment": {
        const attachment = m.attachments[idx];
        if (attachment) blocks.push({ type: "attachment", attachment });
        break;
      }
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

export type ChatHistoryResult =
  | { ok: true; messages: DisplayMessage[] }
  | { ok: false; status: number; error: string };

export async function getChatHistory(
  assistantId: string,
  conversationId: string,
): Promise<ChatHistoryResult> {
  try {
    const { data, error, response } = await messagesGet({
      path: { assistant_id: assistantId },
      query: { conversationId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch history");

    if (!response.ok) {
      const msg = extractErrorMessage(
        error,
        response,
        "Failed to fetch history",
      );
      return {
        ok: false,
        status: response.status,
        error: msg,
      };
    }

    const messages = (data?.messages ?? []).map(mapRuntimeToDisplayMessage);

    return { ok: true, messages };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Something went wrong.",
    };
  }
}

/**
 * Default page size for reconciliation/seq snapshot fetches. The silent-stall
 * watchdog and post-send seq probes only ever inspect the conversation tail
 * (the current turn and any newly-appended rows) plus the snapshot `seq`, so
 * pulling the latest page is sufficient — and avoids re-downloading the entire
 * conversation, which on a long chat is a large payload fetched alongside the
 * paginated history query that already loads the same tail.
 */
export const RECONCILE_LATEST_PAGE_LIMIT = 50;

/**
 * Fetch the server's authoritative `/messages` snapshot for a conversation.
 * Used for post-stream reconciliation to ensure local state matches the
 * backend even if events were dropped or the stream was interrupted.
 *
 * Returns the raw daemon response, which carries the persisted
 * `ConversationMessage` rows alongside the snapshot watermark `seq`. Callers
 * read `messages` directly and use `seq` for the seq-aware reconcile, which
 * compares it against the live applied frontier. `seq` is absent on daemons
 * that predate the seq-on-snapshot contract.
 *
 * Pass `latestPageLimit` to fetch only the newest page (`page=latest`) instead
 * of the full conversation. Reconciliation and seq probes use this: they only
 * read the tail and `seq`, both of which the `page=latest` response carries
 * (the daemon emits `seq`/`processing` on the paginated path identically to the
 * full-snapshot path). Omit it — as the inspector does — to download every
 * message, which the inspector genuinely needs to enumerate the conversation.
 */
export async function fetchConversationMessages(
  assistantId: string,
  conversationId: string,
  options?: { latestPageLimit?: number },
): Promise<MessagesGetResponse | undefined> {
  const query: NonNullable<MessagesGetData["query"]> =
    options?.latestPageLimit != null
      ? { conversationId, page: "latest", limit: options.latestPageLimit }
      : { conversationId };
  const { data, error, response } = await messagesGet({
    path: { assistant_id: assistantId },
    query,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch conversation messages");
  if (!response.ok) {
    throw new Error(
      `Failed to fetch conversation messages (HTTP ${response.status})`,
    );
  }
  return data;
}

export type PostMessageResult =
  | {
      ok: true;
      queued?: false;
      assistantId: string;
      /** The authoritative conversation id from the assistant. Always
       *  populated regardless of whether the caller supplied an id on
       *  input — on the server-minted flow this is the freshly minted
       *  id, on the legacy flow it's the resolved/echoed id. */
      conversationId: string;
      messageId: string;
    }
  | {
      ok: true;
      queued: true;
      assistantId: string;
      /** The authoritative conversation id from the assistant. Always
       *  populated regardless of whether the caller supplied an id on
       *  input — on the server-minted flow this is the freshly minted
       *  id, on the legacy flow it's the resolved/echoed id. */
      conversationId: string;
      requestId?: string;
    }
  | { ok: false; status: number; error: { code?: string; detail?: string } };

export type UploadAttachmentResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: { detail?: string } };

/**
 * Upload a single file as a chat attachment and return the server-assigned id.
 *
 * The assistant backend exposes a multipart upload at
 * `/v1/assistants/{assistant_id}/attachments` that accepts a `file` field
 * plus `filename` and `mimeType` text fields. The response body contains an
 * `id` that can be included in a subsequent `postChatMessage` call via
 * `attachmentIds`.
 */
export async function uploadChatAttachment(
  assistantId: string,
  file: File,
): Promise<UploadAttachmentResult> {
  const filename = file.name || "attachment";
  const mimeType = file.type || "application/octet-stream";

  const { data, error, response } = await attachmentsPost({
    path: { assistant_id: assistantId },
    body: { file, filename, mimeType },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to upload attachment");

  if (!response.ok) {
    const errorBody =
      error && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>)
        : {};
    const detail =
      (typeof errorBody.detail === "string" ? errorBody.detail : undefined) ??
      (typeof errorBody.error === "string" ? errorBody.error : undefined) ??
      `HTTP ${response.status}`;
    return { ok: false, status: response.status, error: { detail } };
  }

  const id = data?.id;
  if (!id) {
    return {
      ok: false,
      status: 422,
      error: { detail: "Upload response did not include an attachment id." },
    };
  }
  return { ok: true, id };
}

/**
 * Send a user message without polling for the response.
 * Returns the assistant/conversation IDs needed to subscribe to events.
 *
 * The optional `onboarding` parameter carries PreChat onboarding context that
 * should be attached only to the FIRST message after PreChat completion. Callers
 * are responsible for the consume-once semantics: include `onboarding` on the
 * initial post and omit it on every subsequent message in the conversation.
 *
 * The wire shape mirrors the macOS `MessageClient.swift` contract:
 *   - `tools`, `tasks`, `tone` are always emitted when `onboarding` is provided
 *     (empty `tools`/`tasks` arrays are valid and represent "user skipped that
 *     screen").
 *   - `userName` and `assistantName` are included when defined (i.e. not
 *     `undefined`). Empty strings ARE preserved on the wire — Swift's
 *     `if let` semantics in `MessageClient.swift` accept any non-nil value
 *     including `""`, so producers that intend to omit the field should
 *     pass `undefined` explicitly. The current caller (`PreChatFlow`)
 *     trims-or-undefined before calling, so the empty-string path is
 *     latent today; if it ever fires, the daemon sees the empty string.
 */
export async function postChatMessage(
  assistantId: string,
  conversationId: string | null,
  content: string,
  attachmentIds: string[] = [],
  onboarding?: PreChatOnboardingContext,
  clientMessageId?: string,
  inferenceProfile?: string | null,
  isHidden?: boolean,
): Promise<PostMessageResult> {
  // Wire-field selection picks exactly one of `conversationId` (0.8.6+
  // strict internal-id lookup) or `conversationKey` (legacy
  // create-or-lookup). See `lib/backwards-compat/conversation-id-wire-field.ts`.
  //
  // The single skip case is the server-minted flow: `conversationId ===
  // null` on a 0.8.6+ assistant. Caller is asking the assistant to mint
  // a conversation row and echo its id back in the response — both
  // fields must be omitted so the assistant takes the mint branch (see
  // `assistant/src/runtime/routes/conversation-routes.ts`
  // `handleSendMessage`). Callers gate `null` on
  // `supportsServerMintedConversation()`.
  //
  // Pre-0.8.6 assistants always receive `conversationKey` — including
  // `conversationKey: null` for safety, since they have no mint branch
  // and need the legacy create-or-lookup path either way.
  const body: MessagesPostData["body"] = {
    content,
    sourceChannel: "vellum",
    // `interface` is the transport surface, not the OS: the web/iOS/macOS apps
    // all run this same web renderer, so the transport is always "web". The
    // daemon keys host-proxy/transport capability off this value, so it must
    // NOT carry the OS. The real platform travels in `clientOs` below and only
    // feeds the assistant's per-turn `client_os` context.
    interface: "web",
    clientOs: detectClientOs(),
  };
  // Read the effective timezone LIVE at send time (not from cached state) so
  // every message carries the user's current zone, keeping the assistant's
  // per-turn time awareness fresh as the OS/browser timezone changes. The
  // daemon route consumes this field in its turn-timezone cascade (see
  // `assistant/src/runtime/routes/conversation-routes.ts`, where the request
  // schema accepts `clientTimezone: z.string().optional()` and forwards it
  // into `resolveTurnTimezoneContext`).
  const clientTimezone = getEffectiveTimezone();
  if (clientTimezone) body.clientTimezone = clientTimezone;
  const conversationField = pickConversationIdWireField();
  if (conversationId !== null || conversationField !== "conversationId") {
    body[conversationField] = conversationId;
  }
  if (attachmentIds.length > 0) {
    body.attachmentIds = attachmentIds;
  }
  // Client-generated idempotency nonce. The daemon persists it, dedupes
  // duplicate sends for the same (conversation, clientMessageId), and echoes
  // it back so the originating client can correlate its optimistic row by
  // identity. Omitted when absent so pre-idempotency daemons are unaffected.
  if (clientMessageId) {
    body.clientMessageId = clientMessageId;
  }
  // Per-conversation model profile for the conversation this message mints — a
  // brand-new draft chat where the user picked a model in the composer before
  // sending. The daemon persists it as the conversation's `inferenceProfile`
  // override (see `conversation-routes.ts` `requestedInferenceProfile`). Omitted
  // otherwise so the conversation inherits the global default profile.
  if (inferenceProfile) {
    body.inferenceProfile = inferenceProfile;
  }
  // Persist the message but suppress it from the transcript (it still drives the
  // turn LLM-side). Used by the research-onboarding "Let's chat" handoff to
  // prime a proactive assistant greeting without showing the triggering message.
  if (isHidden) {
    body.hidden = true;
  }
  const normalizedOnboarding = onboarding
    ? normalizePreChatOnboardingContext(onboarding)
    : undefined;
  if (normalizedOnboarding) {
    const onboardingDict: NonNullable<MessagesPostData["body"]["onboarding"]> =
      {
        tools: normalizedOnboarding.tools,
        tasks: normalizedOnboarding.tasks,
        tone: normalizedOnboarding.tone,
      };
    if (normalizedOnboarding.userName !== undefined)
      onboardingDict.userName = normalizedOnboarding.userName;
    if (normalizedOnboarding.occupation !== undefined)
      onboardingDict.occupation = normalizedOnboarding.occupation;
    if (normalizedOnboarding.assistantName !== undefined)
      onboardingDict.assistantName = normalizedOnboarding.assistantName;
    if (normalizedOnboarding.googleConnected !== undefined)
      onboardingDict.googleConnected = normalizedOnboarding.googleConnected;
    if (normalizedOnboarding.googleScopes !== undefined)
      onboardingDict.googleScopes = normalizedOnboarding.googleScopes;
    if (normalizedOnboarding.priorAssistants !== undefined)
      onboardingDict.priorAssistants = normalizedOnboarding.priorAssistants;
    if (normalizedOnboarding.cohort !== undefined)
      onboardingDict.cohort = normalizedOnboarding.cohort;
    if (normalizedOnboarding.bootstrapTemplate !== undefined)
      onboardingDict.bootstrapTemplate = normalizedOnboarding.bootstrapTemplate;
    if (
      normalizedOnboarding.initialMessage !== undefined &&
      normalizedOnboarding.initialMessage
        .trim()
        .toLowerCase()
        .replace(/[.!?]+$/, "") !== "wake up, my friend"
    )
      onboardingDict.initialMessage = normalizedOnboarding.initialMessage;
    if (normalizedOnboarding.skills !== undefined)
      onboardingDict.skills = normalizedOnboarding.skills;
    if (normalizedOnboarding.title !== undefined)
      onboardingDict.title = normalizedOnboarding.title;
    body.onboarding = onboardingDict;
  }
  if (normalizedOnboarding) {
    void persistPreChatOnboardingProfile(
      assistantId,
      normalizedOnboarding,
    ).catch((err) =>
      captureError(err, { context: "persistPreChatOnboardingProfile" }),
    );
  }
  const {
    data,
    error,
    response: sendResponse,
  } = await messagesPost({
    path: { assistant_id: assistantId },
    body,
    throwOnError: false,
  });
  assertHasResponse(sendResponse, error, "Failed to send chat message");

  if (!sendResponse.ok) {
    const errorBody =
      error && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>)
        : {};
    const nestedError =
      errorBody.error &&
      typeof errorBody.error === "object" &&
      !Array.isArray(errorBody.error)
        ? (errorBody.error as Record<string, unknown>)
        : {};

    // The daemon's non-standard error envelopes use `errorBody.error` as a
    // bare code string (e.g. "secret_blocked") and `errorBody.message` for
    // the user-facing copy. Treat `errorBody.error` (string) only as a code
    // candidate, never as the user-facing `detail` — otherwise the UI shows
    // the raw code instead of the friendly explanation.
    return {
      ok: false,
      status: sendResponse.status,
      error: {
        code:
          typeof errorBody.code === "string"
            ? errorBody.code
            : typeof nestedError.code === "string"
              ? nestedError.code
              : typeof errorBody.error === "string"
                ? errorBody.error
                : undefined,
        detail:
          (typeof errorBody.detail === "string"
            ? errorBody.detail
            : undefined) ??
          (typeof errorBody.message === "string"
            ? errorBody.message
            : undefined) ??
          (typeof nestedError.message === "string"
            ? nestedError.message
            : undefined) ??
          `HTTP ${sendResponse.status}`,
      },
    };
  }

  const sendData = data;
  if (!sendData?.accepted) {
    return {
      ok: false,
      status: 422,
      error: { detail: "Message was not accepted by the assistant." },
    };
  }

  // The assistant is the source of truth for the conversation id —
  // `handleSendMessage` returns it on every success path (echoed when
  // the caller supplied one, minted when both wire fields were
  // omitted). Treat a missing id as a contract violation so the caller
  // never threads `undefined` through downstream code (chat history,
  // URL navigation, draft resolution).
  //
  // Followup: once `PostMessageResult` lives in the assistant API
  // schema, swap this for a zod parse — at that point `conversationId`
  // will be guaranteed-present by the schema and this branch becomes
  // unreachable.
  const resolvedConversationId =
    typeof sendData.conversationId === "string"
      ? sendData.conversationId
      : undefined;
  if (resolvedConversationId === undefined) {
    return {
      ok: false,
      status: 422,
      error: {
        detail:
          "Assistant accepted the message but did not return a conversation id.",
      },
    };
  }

  if (sendData.queued) {
    return {
      ok: true,
      queued: true,
      assistantId,
      conversationId: resolvedConversationId,
      requestId:
        typeof sendData.requestId === "string" ? sendData.requestId : undefined,
    };
  }

  if (typeof sendData.messageId !== "string") {
    return {
      ok: false,
      status: 422,
      error: { detail: "Message was not accepted by the assistant." },
    };
  }

  return {
    ok: true,
    assistantId,
    conversationId: resolvedConversationId,
    messageId: sendData.messageId,
  };
}

/**
 * Steer the assistant to a queued message by aborting the current
 * generation and promoting the message to the head of the queue.
 */
export async function steerToMessage(
  assistantId: string,
  conversationId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const { response } = await messagesQueuedByIdSteerPost({
      path: { assistant_id: assistantId, id: requestId },
      query: { conversationId },
      throwOnError: false,
    });
    return response?.ok ?? false;
  } catch {
    return false;
  }
}

/**
 * Delete a queued message before it is processed by the daemon.
 * Routes through the assistant runtime proxy to the daemon's
 * DELETE /messages/queued/:requestId endpoint.
 */
export async function deleteQueuedMessage(
  assistantId: string,
  conversationId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const { response } = await messagesQueuedByIdDelete({
      path: { assistant_id: assistantId, id: requestId },
      query: { conversationId },
      throwOnError: false,
    });
    return response?.ok ?? false;
  } catch {
    return false;
  }
}
