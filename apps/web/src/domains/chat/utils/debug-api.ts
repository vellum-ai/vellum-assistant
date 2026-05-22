/**
 * Dev-facing chat debug API surfaced on `window._vellumDebug.chat`.
 *
 * Designed for in-the-moment inspection when a chat-streaming bug shows
 * up — open DevTools, call `window._vellumDebug.chat.tail()` to see the
 * transcript rows the chat page is rendering, `.forceReconcile()` to
 * imperatively run /v1/history reconcile, and `.serverMessages()` to
 * fetch the raw `/v1/history` message list (so you can diff against
 * `tail()` by hand in the console when a turn looks stuck).
 *
 * Attached unconditionally (no query-param gating) so the API is
 * available in dev, staging, and production builds. The implementation
 * is a thin consumer of state already tracked elsewhere (refs in
 * ChatPage) — it adds no new background work and no
 * production-path overhead beyond a global property assignment.
 *
 * The namespace is intentionally nested under `_vellumDebug` so other
 * areas of the app (sync, gateway, telemetry) can hang their own
 * sub-objects off the same root without colliding.
 */

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";

import {
  fetchConversationMessages as defaultFetchConversationMessages,
  type RuntimeMessage,
} from "@/domains/chat/api/messages.js";
import type { ChatEventStream } from "@/domains/chat/api/stream.js";
import { recordChatDiagnostic } from "@/domains/chat/utils/diagnostics.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation.js";
import type { TranscriptItem } from "@/domains/chat/transcript/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChatDebugTailMessage {
  index: number;
  key: string;
  kind: "message";
  role: "user" | "assistant";
  stableId: string;
  id: string | null;
  daemonMessageId: string | null;
  timestamp: number | null;
  isStreaming: boolean;
  queueStatus: string | null;
  queuePosition: number | null;
  content: string;
  contentLength: number;
  toolCalls: Array<{
    id: string;
    toolName: string;
    status: string;
    isError: boolean;
    resultLength: number | null;
  }>;
  surfaces: Array<{
    surfaceId: string;
    surfaceType: string;
    title: string | null;
    completed: boolean;
  }>;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

export type ChatDebugTailItem =
  | ChatDebugTailMessage
  | {
      index: number;
      key: string;
      kind: "thinking";
      label: string | null;
    }
  | {
      index: number;
      key: string;
      kind: "pendingSecret" | "pendingConfirmation";
      requestId: string;
    }
  | {
      index: number;
      key: string;
      kind: "pendingContactRequest";
      requestId: string;
      channel: string | null;
      label: string | null;
      role: string | null;
    }
  | {
      index: number;
      key: string;
      kind: "surface";
      surfaceId: string;
      surfaceType: string;
      title: string | null;
      completed: boolean;
    }
  | {
      index: number;
      key: string;
      kind: "queuedMarker";
      count: number;
    }
  | {
      index: number;
      key: string;
      kind: "error";
      message: string;
    }
  | {
      index: number;
      key: string;
      kind: "onboardingChoice";
    };

/** The dev API surface attached to `window._vellumDebug.chat`. */
export interface ChatDebugApi {
  /**
   * Return up to `limit` transcript items currently projected for rendering.
   * Items are returned in chronological transcript order; the last row is the
   * current visual bottom of the chat.
   */
  tail(limit?: number): ChatDebugTailItem[];
  /**
   * [experimental] Imperatively trigger a reconcile of the active conversation
   * against `/v1/history`. Returns the same shape as the watchdog /
   * resume / cache-restore reconcile paths. Subject to change.
   */
  forceReconcile(): Promise<ReconcileActiveConversationResult>;
  /**
   * [experimental] Fetch `/v1/history` for the active assistant +
   * conversation and return the raw server-side message list. Does
   * not touch UI state — diff against `tail()` manually in the console
   * when you need to declare drift. Throws if there's no active
   * assistant/conversation context. Subject to change.
   */
  serverMessages(): Promise<RuntimeMessage[]>;
  /** Print help for this API. Log-only, returns undefined. */
  help(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_TAIL_LIMIT = 20;
const ROOT_NS = "_vellumDebug";
const CHAT_NS = "chat";

/**
 * Refs the API reads to tail transcript items and trigger actions. All are
 * `MutableRefObject` because the API holds them across the lifetime of
 * the chat page and reads them lazily on each call — capturing the
 * current value at install time would freeze the API to the initial render.
 */
export interface ChatDebugRefs {
  messagesRef: MutableRefObject<DisplayMessage[]>;
  transcriptItemsRef: MutableRefObject<TranscriptItem[]>;
  streamContextRef: MutableRefObject<{
    assistantId: string;
    conversationKey: string;
  } | null>;
  streamRef: MutableRefObject<ChatEventStream | null>;
  streamEpochRef: MutableRefObject<number>;
  activeConversationKeyRef: MutableRefObject<string | null>;
  /**
   * Reads the current assistantId. Held as a getter rather than a ref
   * because the value lives in a hook return value in ChatPage, not in
   * a dedicated ref.
   */
  getAssistantId: () => string | null;
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
  /**
   * Optional injector for the `/v1/history` fetch. Defaults to
   * {@link fetchConversationMessages} from `@/domains/chat/api/messages.js`
   * when omitted. Injected primarily so unit tests can substitute a fake
   * without mocking the whole module (which would leak to sibling test
   * files in the same process).
   */
  historyFetcher?: (
    assistantId: string,
    conversationKey: string,
  ) => Promise<RuntimeMessage[]>;
}

function summarizeTailItem(
  item: TranscriptItem,
  index: number,
): ChatDebugTailItem {
  switch (item.kind) {
    case "message": {
      const { message } = item;
      return {
        index,
        key: item.key,
        kind: "message",
        role: message.role,
        stableId: message.stableId,
        id: message.id ?? null,
        daemonMessageId: message.daemonMessageId ?? null,
        timestamp: message.timestamp ?? null,
        isStreaming: message.isStreaming === true,
        queueStatus: message.queueStatus ?? null,
        queuePosition: message.queuePosition ?? null,
        content: message.content,
        contentLength: message.content.length,
        toolCalls: (message.toolCalls ?? []).map((toolCall) => ({
          id: toolCall.id,
          toolName: toolCall.toolName,
          status: toolCall.status,
          isError: toolCall.isError === true,
          resultLength:
            typeof toolCall.result === "string"
              ? toolCall.result.length
              : null,
        })),
        surfaces: (message.surfaces ?? []).map((surface) => ({
          surfaceId: surface.surfaceId,
          surfaceType: surface.surfaceType,
          title: surface.title ?? null,
          completed: surface.completed === true,
        })),
        attachments: (message.attachments ?? []).map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      };
    }
    case "thinking":
      return {
        index,
        key: item.key,
        kind: "thinking",
        label: item.label ?? null,
      };
    case "pendingSecret":
    case "pendingConfirmation":
      return {
        index,
        key: item.key,
        kind: item.kind,
        requestId: item.requestId,
      };
    case "pendingContactRequest":
      return {
        index,
        key: item.key,
        kind: "pendingContactRequest",
        requestId: item.requestId,
        channel: item.channel ?? null,
        label: item.label ?? null,
        role: item.role ?? null,
      };
    case "surface":
      return {
        index,
        key: item.key,
        kind: "surface",
        surfaceId: item.surface.surfaceId,
        surfaceType: item.surface.surfaceType,
        title: item.surface.title ?? null,
        completed: item.surface.completed === true,
      };
    case "queuedMarker":
      return {
        index,
        key: item.key,
        kind: "queuedMarker",
        count: item.count,
      };
    case "error":
      return { index, key: item.key, kind: "error", message: item.message };
    case "onboardingChoice":
      return { index, key: item.key, kind: "onboardingChoice" };
  }
}

/**
 * Build the {@link ChatDebugApi} closure-bound to a set of refs. Pure
 * factory so it can be unit-tested without a `window`.
 */
export function createChatDebugApi(refs: ChatDebugRefs): ChatDebugApi {
  function tail(limit: number = DEFAULT_TAIL_LIMIT): ChatDebugTailItem[] {
    const safeLimit =
      Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : DEFAULT_TAIL_LIMIT;
    const items = refs.transcriptItemsRef.current ?? [];
    const startIndex = Math.max(0, items.length - safeLimit);
    return items
      .slice(startIndex)
      .map((item, offset) => summarizeTailItem(item, startIndex + offset));
  }

  async function forceReconcile(): Promise<ReconcileActiveConversationResult> {
    recordChatDiagnostic("debug_force_reconcile_start", {
      activeConversationKey: refs.activeConversationKeyRef.current,
      assistantId: refs.getAssistantId(),
    });
    const result = await refs.reconcileActiveConversation();
    recordChatDiagnostic("debug_force_reconcile_result", {
      activeConversationKey: refs.activeConversationKeyRef.current,
      changed: result.changed,
      messagesAdded: result.messagesAdded,
      assistantProgress: result.assistantProgress,
    });
    return result;
  }

  async function serverMessages(): Promise<RuntimeMessage[]> {
    // Resolve context from `streamContextRef` first (matches what
    // reconcile would use); fall back to assistantId +
    // activeConversationKey so the call still works during a brief
    // conv-switch window where the stream context is transiently null.
    const streamContext = refs.streamContextRef.current;
    const assistantId =
      streamContext?.assistantId ?? refs.getAssistantId() ?? null;
    const conversationKey =
      streamContext?.conversationKey ??
      refs.activeConversationKeyRef.current ??
      null;
    if (!assistantId || !conversationKey) {
      throw new Error(
        "serverMessages: no active assistant/conversation context",
      );
    }
    const historyFetcher =
      refs.historyFetcher ?? defaultFetchConversationMessages;
    return await historyFetcher(assistantId, conversationKey);
  }

  function help(): void {
    const lines = [
      "window._vellumDebug.chat — surgical chat debug API",
      "",
      "  .tail(n?)                  rendered transcript items; last row = visual chat bottom",
      "  .forceReconcile()          [experimental] imperatively run /v1/history reconcile",
      "  .serverMessages()          [experimental] fetch /v1/history and return server message list",
      "                              (diff against tail() manually in the console)",
      "  .help()                    print this message",
    ];
    console.log(lines.join("\n"));
  }

  return {
    tail,
    forceReconcile,
    serverMessages,
    help,
  };
}

// ---------------------------------------------------------------------------
// Global install / uninstall
// ---------------------------------------------------------------------------

interface VellumDebugRoot extends Record<string, unknown> {
  [CHAT_NS]?: ChatDebugApi;
}

/**
 * Attach `api` to `window._vellumDebug.chat`. Returns a cleanup
 * function that removes the binding (and removes the root object if
 * it's empty afterwards). Safe to call on the server — no-op when
 * `window` is undefined.
 */
export function installChatDebugApi(api: ChatDebugApi): () => void {
  if (typeof window === "undefined") return () => {};
  const win = window as Omit<Window, typeof ROOT_NS> & { [ROOT_NS]?: VellumDebugRoot };
  const existing: VellumDebugRoot = (win[ROOT_NS] ?? {}) as VellumDebugRoot;
  existing[CHAT_NS] = api;
  win[ROOT_NS] = existing;
  return () => {
    const current = win[ROOT_NS];
    if (!current) return;
    if (current[CHAT_NS] === api) {
      delete current[CHAT_NS];
    }
    // Only remove the root if we left it empty — other debug domains
    // may have attached siblings under the same namespace.
    if (Object.keys(current).length === 0) {
      delete win[ROOT_NS];
    }
  };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Wire {@link createChatDebugApi} into a React component's lifecycle.
 *
 * The API is installed once on mount and torn down on unmount. The
 * `MutableRefObject`s in `refs` are stable across the host page's
 * lifetime so we capture them directly. The two non-ref dependencies
 * (`getAssistantId`, `reconcileActiveConversation`) are routed through
 * a sibling ref updated on every render so the API's closures always
 * see the latest values — without this, the API would freeze them to
 * the values present at first mount.
 */
export function useChatDebugApi(refs: ChatDebugRefs): void {
  const latestRefs = useRef(refs);
  latestRefs.current = refs;

  useEffect(() => {
    const stableRefs: ChatDebugRefs = {
      messagesRef: refs.messagesRef,
      transcriptItemsRef: refs.transcriptItemsRef,
      streamContextRef: refs.streamContextRef,
      streamRef: refs.streamRef,
      streamEpochRef: refs.streamEpochRef,
      activeConversationKeyRef: refs.activeConversationKeyRef,
      getAssistantId: () => latestRefs.current.getAssistantId(),
      reconcileActiveConversation: () =>
        latestRefs.current.reconcileActiveConversation(),
      historyFetcher: refs.historyFetcher,
    };
    const api = createChatDebugApi(stableRefs);
    const uninstall = installChatDebugApi(api);
    return uninstall;
  }, []);
}
