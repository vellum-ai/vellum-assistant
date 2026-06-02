/**
 * Message operations: history retrieval, polling, sending, and attachments.
 *
 * Includes `RuntimeMessage` / `RuntimeToolCall` types used for daemon
 * history payloads, content normalization helpers, and the `postChatMessage`
 * / `uploadChatAttachment` / `deleteQueuedMessage` write operations.
 */

import { captureError } from "@/lib/sentry/capture-error";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type {
  DisplayMessage,
  SlackRuntimeMessage,
  Surface,
} from "@/domains/chat/types/types";
import { client } from "@/generated/api/client.gen";
import {
  messagesPost,
  messagesQueuedByIdSteerPost,
  messagesQueuedByIdDelete,
} from "@/generated/daemon/sdk.gen";
import type { MessagesPostData } from "@/generated/daemon/types.gen";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import {
  normalizePreChatOnboardingContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import { persistPreChatOnboardingProfile } from "@/domains/onboarding/prechat-profile";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { pickConversationIdWireField } from "@/lib/backwards-compat/conversation-id-wire-field";
import { getEffectiveTimezone } from "@/utils/effective-timezone";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

/** Shape of a single tool call as returned by the daemon's history endpoint. */
export interface RuntimeToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** Risk level classification at invocation time ("low" | "medium" | "high" | "unknown"). */
  riskLevel?: string;
  /** Human-readable reason for the risk classification. */
  riskReason?: string;
  /** Whether the tool was auto-approved (true) or required explicit user input (false). */
  autoApproved?: boolean;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** How the approval decision was reached. */
  approvalMode?: string;
  /** Why the approval decision was reached. */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at execution time. */
  riskThreshold?: string;
  /** Unix ms timestamp when the tool call started. Persisted by the daemon; used for duration display. */
  startedAt?: number;
  /** Unix ms timestamp when the tool call completed. Persisted by the daemon; used for duration display. */
  completedAt?: number;
  /** Explicit confirmation decision persisted by the daemon ("approved" | "denied" | "timed_out"). */
  confirmationDecision?: string;
}

/** Attachment metadata returned by the daemon's message history endpoint. */
export interface RuntimeAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  /** Base64-encoded file data. Only populated for images on history reload. */
  data?: string;
  thumbnailData?: string;
  fileBacked?: boolean;
}

/** Subagent notification embedded in assistant history messages. */
export interface RuntimeSubagentNotification {
  subagentId: string;
  label: string;
  status: string;
  error?: string;
  conversationId?: string;
  /** StableId of the parent assistant message that spawned this subagent. */
  parentMessageStableId?: string;
  /** Daemon UUID of the parent assistant message. Stable across reloads. */
  parentMessageId?: string;
}

export interface RuntimeMessage {
  id: string;
  /** Server message ids folded into this canonical history row. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  surfaces?: Surface[];
  textSegments?: Array<{
    type: string;
    content: string;
    [key: string]: unknown;
  }>;
  contentOrder?: Array<{ type: string; id: string }>;
  metadata?: Record<string, unknown>;
  slackMessage?: SlackRuntimeMessage;
  toolCalls?: RuntimeToolCall[];
  /** Structured attachment metadata from the daemon's history endpoint. */
  attachments?: RuntimeAttachment[];
  /** Server-provided timestamp as epoch milliseconds or an ISO string. */
  timestamp?: number | string;
  /** Reasoning segments from thinking-capable models. Each entry maps to
   *  a `thinking:N` entry in `contentOrder`. */
  thinkingSegments?: string[];
  /** Subagent notification attached to this history message by the daemon. */
  subagentNotification?: RuntimeSubagentNotification;
}

interface ListMessagesResponse {
  messages: RuntimeMessage[];
}

export async function pollForResponse(
  assistantId: string,
  userMessageId: string,
  conversationId: string,
): Promise<RuntimeMessage | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data, error, response } = await client.get<
      ListMessagesResponse,
      unknown
    >({
      url: "/v1/assistants/{assistant_id}/messages/",
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

    const messages = Array.isArray(data?.messages) ? data.messages : [];

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
 * Convert daemon-returned tool calls into the ChatMessageToolCall shape
 * used by the web client. The daemon returns `{ name, input, result?, isError? }`
 * while the UI expects `{ id, toolName, input, status, result?, isError? }`.
 * The synthesised `id` uses the array index, matching how contentOrder
 * references tool calls by index in history payloads.
 */
export function mapRuntimeToolCalls(
  toolCalls: RuntimeToolCall[],
  messageId: string,
): ChatMessageToolCall[] {
  return toolCalls.map((tc, idx) => ({
    id: `tool-history-${messageId}-${idx}`,
    toolName: tc.name,
    input: tc.input,
    status: tc.isError
      ? ("error" as const)
      : tc.result === undefined
        ? ("running" as const)
        : ("completed" as const),
    ...(tc.result !== undefined ? { result: tc.result } : {}),
    ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
    ...(tc.riskLevel !== undefined ? { riskLevel: tc.riskLevel } : {}),
    ...(tc.riskReason !== undefined ? { riskReason: tc.riskReason } : {}),
    ...(tc.matchedTrustRuleId !== undefined
      ? { matchedTrustRuleId: tc.matchedTrustRuleId }
      : {}),
    ...(tc.approvalMode !== undefined ? { approvalMode: tc.approvalMode } : {}),
    ...(tc.approvalReason !== undefined
      ? { approvalReason: tc.approvalReason }
      : {}),
    ...(tc.riskThreshold !== undefined
      ? { riskThreshold: tc.riskThreshold }
      : {}),
    ...(tc.startedAt !== undefined ? { startedAt: tc.startedAt } : {}),
    ...(tc.completedAt !== undefined ? { completedAt: tc.completedAt } : {}),
    ...(tc.confirmationDecision !== undefined
      ? {
          confirmationDecision: tc.confirmationDecision as
            | "approved"
            | "denied"
            | "timed_out",
        }
      : {}),
  }));
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
 * Normalize a textSegments array from the server. The server sends plain
 * strings, but the client expects objects with `{ type, content }`.
 */
export function normalizeTextSegments(
  raw: unknown[] | undefined,
):
  | Array<{ type: string; content: string; [key: string]: unknown }>
  | undefined {
  if (!raw || raw.length === 0) return undefined;
  const result: Array<{
    type: string;
    content: string;
    [key: string]: unknown;
  }> = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      result.push({ type: "text", content: entry });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.content === "string") {
        const type = typeof obj.type === "string" ? obj.type : "text";
        result.push({ ...obj, type, content: obj.content } as {
          type: string;
          content: string;
          [key: string]: unknown;
        });
      }
    }
  }
  return result.length > 0 ? result : undefined;
}

export type ChatHistoryResult =
  | { ok: true; messages: DisplayMessage[] }
  | { ok: false; status: number; error: string };

export async function getChatHistory(
  assistantId: string,
  conversationId: string,
): Promise<ChatHistoryResult> {
  try {
    const { data, error, response } = await client.get<
      ListMessagesResponse,
      unknown
    >({
      url: "/v1/assistants/{assistant_id}/messages/",
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

    const messages = (Array.isArray(data?.messages) ? data.messages : [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map(mapRuntimeToDisplayMessage);

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
 * Fetch the server's authoritative message list for a conversation.
 * Used for post-stream reconciliation to ensure local state matches the
 * backend even if events were dropped or the stream was interrupted.
 */
export async function fetchConversationMessages(
  assistantId: string,
  conversationId: string,
): Promise<RuntimeMessage[]> {
  const { data, error, response } = await client.get<
    ListMessagesResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/messages/",
    path: { assistant_id: assistantId },
    query: { conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch conversation messages");
  if (!response.ok) {
    throw new Error(
      `Failed to fetch conversation messages (HTTP ${response.status})`,
    );
  }
  return Array.isArray(data?.messages) ? data.messages : [];
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
 * `/v1/assistants/{assistant_id}/attachments/` that accepts a `file` field
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

  const form = new FormData();
  form.append("filename", filename);
  form.append("mimeType", mimeType);
  form.append("file", file, filename);

  const { data, error, response } = await client.post<
    Record<string, unknown>,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/attachments/",
    path: { assistant_id: assistantId },
    body: form as unknown as Record<string, unknown>,
    // Pass the FormData through without serialization so the browser sets
    // the correct multipart boundary on Content-Type.
    bodySerializer: (body: unknown) => body as BodyInit,
    headers: {
      // Let fetch compute the multipart boundary for us.
      "Content-Type": null,
    },
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

  const dataRecord =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  const rawId = dataRecord?.id;
  const id = typeof rawId === "string" ? rawId : undefined;
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
    interface: "vellum",
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
