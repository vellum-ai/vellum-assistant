/**
 * Dev-facing chat debug API surfaced on `window._vellumDebug.chat`.
 *
 * Designed for in-the-moment inspection when a chat-streaming bug shows
 * up — open DevTools, call `window._vellumDebug.chat.snapshot()` to grab
 * current client state, `.diffAgainstServer()` to compare local
 * messages against `/v1/history`, `.forceReconcile()` to imperatively
 * run reconcile, and `.tailEvents()` to inspect the chat diagnostics
 * ring buffer.
 *
 * Attached unconditionally (no query-param gating) so the API is
 * available in dev, staging, and production builds. The implementation
 * is a thin consumer of state already tracked elsewhere (refs in
 * ChatPage + the existing sessionStorage ring buffer in
 * `diagnostics.ts`) — it adds no new background work and no
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
import {
  type ChatDiagnosticsEvent,
  getChatDiagnosticsEvents,
  recordChatDiagnostic,
  resolvePlatformTag,
  summarizeDisplayMessage,
} from "@/domains/chat/utils/diagnostics.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import { type TurnState, useTurnStore } from "@/domains/messaging/turn-store.js";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Compact view of an in-flight streaming bubble for the snapshot. */
export interface StreamingBubbleSummary {
  stableId: string;
  id: string | null;
  role: string;
  contentLength: number;
  /**
   * Milliseconds between {@link DisplayMessage.timestamp} (message
   * creation time) and now. NOT "time since last delta" — text-delta
   * timestamps are not currently tracked per bubble. Use this as a
   * rough "how old is this bubble" signal; combine with
   * `diffAgainstServer()` to see whether the server has long since
   * finished the turn.
   */
  ageMs: number | null;
  /** First {@link CONTENT_PREVIEW_CHARS} characters of the bubble's content. */
  contentPrefix: string;
}

/** Result of {@link ChatDebugApi.snapshot}. */
export interface ChatDebugSnapshot {
  /** When the snapshot was taken. */
  timestamp: string;
  /** Platform tag (`web`, `ios`, `android`). */
  platform: string;
  /** Assistant ID this chat view is bound to. */
  assistantId: string | null;
  /** Conversation key the user currently has focused. */
  activeConversationKey: string | null;
  /**
   * Assistant + conversation the SSE stream is bound to right now. May
   * lag `activeConversationKey` by one render during a conv switch.
   */
  streamContext: { assistantId: string; conversationKey: string } | null;
  /** Whether the SSE transport handle is currently non-null. */
  streamConnected: boolean;
  /**
   * Monotonic counter incremented each time the stream is reopened.
   * Useful for spotting reconnect churn vs. a single long-lived
   * connection.
   */
  streamEpoch: number;
  /** Full turn state machine snapshot. */
  turn: TurnState;
  /** Aggregate counts and the streaming-bubble subset. */
  messages: {
    total: number;
    streamingCount: number;
    queuedCount: number;
    processingCount: number;
    streamingBubbles: StreamingBubbleSummary[];
    /** Compact summary of the last message in the list. */
    last: ReturnType<typeof summarizeDisplayMessage> | null;
  };
  /** Ring buffer stats — counts only, full events come from `tailEvents()`. */
  diagnostics: {
    ringBufferSize: number;
    /** kind → count, sorted descending in the returned object. */
    countsByKind: Record<string, number>;
    last: ChatDiagnosticsEvent | null;
  };
  /** Synchronous client-side invariant checks. */
  invariants: {
    /** `messages.filter(m => m.isStreaming).length <= 1`. */
    singleStreamingBubble: { ok: boolean; streamingCount: number };
  };
}

/** Per-message drift entry returned by {@link ChatDebugApi.diffAgainstServer}. */
export interface ChatDebugContentDrift {
  stableId: string;
  id: string | null;
  role: string;
  localContentLength: number;
  serverContentLength: number;
}

/** Result of {@link ChatDebugApi.diffAgainstServer}. */
export interface ChatDebugDiff {
  /**
   * Context the diff was computed against. Pulled from
   * `streamContextRef` first (matches what reconcile would use); falls
   * back to `assistantId` + `activeConversationKey` so the diff is
   * still callable during a brief conv-switch window where the stream
   * context is briefly null.
   */
  context: { assistantId: string; conversationKey: string };
  /** When the server fetch completed. */
  fetchedAt: string;
  /** Local message counts. */
  local: { total: number; streamingCount: number };
  /** Server message count from `/v1/history`. */
  serverTotal: number;
  /**
   * Messages present locally but not on the server (matched by `id`;
   * local messages without an `id` are always included here — those
   * are the streaming-bubble orphans we care about).
   */
  localOnly: ReturnType<typeof summarizeDisplayMessage>[];
  /** Messages present on the server but missing locally. */
  serverOnly: Array<{
    id: string;
    role: string;
    contentLength: number;
    timestamp: number | null;
  }>;
  /** Messages on both sides whose content lengths disagree. */
  contentDrift: ChatDebugContentDrift[];
}

/** The dev API surface attached to `window._vellumDebug.chat`. */
export interface ChatDebugApi {
  /** Synchronous snapshot of current client chat state. */
  snapshot(): ChatDebugSnapshot;
  /**
   * Return up to `limit` recent diagnostic events from the ring buffer.
   * When `filter.kindStartsWith` is supplied, only events whose `kind`
   * begins with that prefix are returned (e.g. `"sse_"`).
   */
  tailEvents(
    limit?: number,
    filter?: { kindStartsWith?: string },
  ): ChatDiagnosticsEvent[];
  /**
   * Imperatively trigger a reconcile of the active conversation
   * against `/v1/history`. Returns the same shape as the watchdog /
   * resume / cache-restore reconcile paths.
   */
  forceReconcile(): Promise<ReconcileActiveConversationResult>;
  /**
   * Fetch `/v1/history` and diff against the local message list.
   * Useful for declaring "this streaming bubble is an orphan" when a
   * turn appears stuck.
   */
  diffAgainstServer(): Promise<ChatDebugDiff>;
  /** Print and return a short help string for DevTools users. */
  help(): string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const CONTENT_PREVIEW_CHARS = 80;
const DEFAULT_TAIL_LIMIT = 20;
const ROOT_NS = "_vellumDebug";
const CHAT_NS = "chat";

/**
 * Refs the API reads to build snapshots and trigger actions. All are
 * `MutableRefObject` because the API holds them across the lifetime of
 * the chat page and reads them lazily on each call — capturing the
 * current value at install time would freeze the snapshot to the
 * initial render.
 */
export interface ChatDebugRefs {
  messagesRef: MutableRefObject<DisplayMessage[]>;
  /** Reads the current turn state from the Zustand store. */
  getTurnState: () => TurnState;
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

function summarizeStreamingBubble(
  message: DisplayMessage,
): StreamingBubbleSummary {
  const ageMs =
    typeof message.timestamp === "number"
      ? Math.max(0, Date.now() - message.timestamp)
      : null;
  return {
    stableId: message.stableId,
    id: message.id ?? null,
    role: message.role,
    contentLength: message.content.length,
    ageMs,
    contentPrefix: message.content.slice(0, CONTENT_PREVIEW_CHARS),
  };
}

function countByKind(events: ChatDiagnosticsEvent[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  // Return as an object sorted descending by count for human-readable
  // DevTools output (JS preserves insertion order on plain objects).
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const result: Record<string, number> = {};
  for (const [kind, count] of sorted) {
    result[kind] = count;
  }
  return result;
}

function summarizeRuntimeMessageShort(message: RuntimeMessage): {
  id: string;
  role: string;
  contentLength: number;
  timestamp: number | null;
} {
  return {
    id: message.id,
    role: message.role,
    contentLength: message.content.length,
    timestamp:
      typeof message.timestamp === "number"
        ? message.timestamp
        : typeof message.timestamp === "string"
          ? new Date(message.timestamp).getTime()
          : null,
  };
}

/**
 * Build the diff between a local message list and a server message
 * list. Pure function so it can be unit-tested without mocking the
 * window or the fetch client.
 *
 * Matching is by `id`. Local messages without an `id` (the streaming
 * bubble shape) always land in `localOnly` — that's the orphan signal
 * we want this method to surface.
 */
export function diffMessages(
  localMessages: DisplayMessage[],
  serverMessages: RuntimeMessage[],
): Pick<ChatDebugDiff, "localOnly" | "serverOnly" | "contentDrift"> {
  const serverById = new Map<string, RuntimeMessage>();
  for (const message of serverMessages) {
    serverById.set(message.id, message);
  }
  const matchedServerIds = new Set<string>();

  const localOnly: ChatDebugDiff["localOnly"] = [];
  const contentDrift: ChatDebugContentDrift[] = [];

  for (const local of localMessages) {
    if (local.id == null) {
      localOnly.push(summarizeDisplayMessage(local));
      continue;
    }
    const server = serverById.get(local.id);
    if (!server) {
      localOnly.push(summarizeDisplayMessage(local));
      continue;
    }
    matchedServerIds.add(local.id);
    if (local.content.length !== server.content.length) {
      contentDrift.push({
        stableId: local.stableId,
        id: local.id,
        role: local.role,
        localContentLength: local.content.length,
        serverContentLength: server.content.length,
      });
    }
  }

  const serverOnly: ChatDebugDiff["serverOnly"] = [];
  for (const server of serverMessages) {
    if (!matchedServerIds.has(server.id)) {
      serverOnly.push(summarizeRuntimeMessageShort(server));
    }
  }

  return { localOnly, serverOnly, contentDrift };
}

/**
 * Build the {@link ChatDebugApi} closure-bound to a set of refs. Pure
 * factory so it can be unit-tested without a `window`.
 */
export function createChatDebugApi(refs: ChatDebugRefs): ChatDebugApi {
  function buildSnapshot(): ChatDebugSnapshot {
    const messages = refs.messagesRef.current ?? [];
    const turn = refs.getTurnState();
    const streamContext = refs.streamContextRef.current;
    const events = getChatDiagnosticsEvents();
    const streamingBubbles = messages
      .filter((message) => message.isStreaming === true)
      .map(summarizeStreamingBubble);
    const streamingCount = streamingBubbles.length;
    return {
      timestamp: new Date().toISOString(),
      platform: resolvePlatformTag(),
      assistantId: refs.getAssistantId(),
      activeConversationKey: refs.activeConversationKeyRef.current,
      streamContext: streamContext
        ? {
            assistantId: streamContext.assistantId,
            conversationKey: streamContext.conversationKey,
          }
        : null,
      streamConnected: refs.streamRef.current != null,
      streamEpoch: refs.streamEpochRef.current,
      turn,
      messages: {
        total: messages.length,
        streamingCount,
        queuedCount: messages.filter(
          (message) => message.queueStatus === "queued",
        ).length,
        processingCount: messages.filter(
          (message) => message.queueStatus === "processing",
        ).length,
        streamingBubbles,
        last:
          messages.length > 0
            ? summarizeDisplayMessage(messages[messages.length - 1]!)
            : null,
      },
      diagnostics: {
        ringBufferSize: events.length,
        countsByKind: countByKind(events),
        last: events.length > 0 ? events[events.length - 1]! : null,
      },
      invariants: {
        singleStreamingBubble: {
          ok: streamingCount <= 1,
          streamingCount,
        },
      },
    };
  }

  function tailEvents(
    limit: number = DEFAULT_TAIL_LIMIT,
    filter?: { kindStartsWith?: string },
  ): ChatDiagnosticsEvent[] {
    const safeLimit =
      Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : DEFAULT_TAIL_LIMIT;
    const events = getChatDiagnosticsEvents();
    const filtered =
      filter?.kindStartsWith != null
        ? events.filter((event) =>
            event.kind.startsWith(filter.kindStartsWith!),
          )
        : events;
    return filtered.slice(-safeLimit);
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

  async function diffAgainstServer(): Promise<ChatDebugDiff> {
    const streamContext = refs.streamContextRef.current;
    const assistantId =
      streamContext?.assistantId ?? refs.getAssistantId() ?? null;
    const conversationKey =
      streamContext?.conversationKey ??
      refs.activeConversationKeyRef.current ??
      null;
    if (!assistantId || !conversationKey) {
      throw new Error(
        "diffAgainstServer: no active assistant/conversation context",
      );
    }
    const localMessages = refs.messagesRef.current ?? [];
    const historyFetcher =
      refs.historyFetcher ?? defaultFetchConversationMessages;
    const serverMessages = await historyFetcher(assistantId, conversationKey);
    const diff = diffMessages(localMessages, serverMessages);
    const localStreamingCount = localMessages.filter(
      (message) => message.isStreaming === true,
    ).length;
    const result: ChatDebugDiff = {
      context: { assistantId, conversationKey },
      fetchedAt: new Date().toISOString(),
      local: {
        total: localMessages.length,
        streamingCount: localStreamingCount,
      },
      serverTotal: serverMessages.length,
      ...diff,
    };
    recordChatDiagnostic("debug_diff_against_server", {
      assistantId,
      conversationKey,
      localTotal: result.local.total,
      localStreamingCount: result.local.streamingCount,
      serverTotal: result.serverTotal,
      localOnlyCount: result.localOnly.length,
      serverOnlyCount: result.serverOnly.length,
      contentDriftCount: result.contentDrift.length,
    });
    return result;
  }

  function help(): string {
    const lines = [
      "window._vellumDebug.chat — surgical chat debug API",
      "",
      "  .snapshot()                 sync snapshot of client state",
      "  .tailEvents(n?, filter?)    recent events from the diagnostics ring buffer",
      "                              filter: { kindStartsWith?: string }",
      "  .forceReconcile()           imperatively run /v1/history reconcile",
      "  .diffAgainstServer()        fetch /v1/history and diff vs local messages",
      "                              (orphan streaming bubbles show up in `localOnly`)",
      "  .help()                     this message",
      "",
      "  Invariants the snapshot asserts:",
      "    - messages.filter(m => m.isStreaming).length <= 1",
    ];
    const text = lines.join("\n");
    // eslint-disable-next-line no-console
    console.log(text);
    return text;
  }

  return {
    snapshot: buildSnapshot,
    tailEvents,
    forceReconcile,
    diffAgainstServer,
    help,
  };
}

// ---------------------------------------------------------------------------
// Global install / uninstall
// ---------------------------------------------------------------------------

interface VellumDebugRoot {
  [CHAT_NS]?: ChatDebugApi;
  [key: string]: unknown;
}

/**
 * Attach `api` to `window._vellumDebug.chat`. Returns a cleanup
 * function that removes the binding (and removes the root object if
 * it's empty afterwards). Safe to call on the server — no-op when
 * `window` is undefined.
 */
export function installChatDebugApi(api: ChatDebugApi): () => void {
  if (typeof window === "undefined") return () => {};
  const win = window as Window & { [ROOT_NS]?: VellumDebugRoot };
  const existing = win[ROOT_NS] ?? {};
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
      getTurnState: () => latestRefs.current.getTurnState(),
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
    // Intentional empty deps: ref identities are stable across the
    // host page's lifetime, and we route non-ref values through
    // `latestRefs` above so we get the latest closures without
    // re-installing the API on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
