/**
 * Manages the always-on SSE `/events` stream lifecycle:
 *
 * 1. **Stream open/close** — opens when the assistant is active and a
 *    server-persisted conversation key exists; closes on cleanup or when
 *    dependencies change.
 * 2. **Reachability retry** — when the reachability probe flips to "ready"
 *    after a stream error, resets turn state and bumps the retry nonce to
 *    re-open the stream. A burst-limiter prevents pathological reconnect
 *    loops.
 * 3. **Visibility / app-resume** — proactively tears down the stream when
 *    the page is hidden (or the Capacitor app backgrounds) and reconciles +
 *    reopens on resume. Deduplicates `visibilitychange` and Capacitor
 *    `appStateChange` signals within a 1 s window.
 * 4. **Unmount cleanup** — cancels the stream, reconciliation loop, and any
 *    pending conversation-list-invalidated timer.
 *
 * Shared refs (`streamRef`, `streamEpochRef`, `reconcileAfterNextStreamOpenRef`,
 * `streamContextRef`) are injected by the caller because other hooks
 * (`useMessageReconciliation`, `useStreamEventHandler`, `useSendMessage`)
 * also read/write them. Burst-limiter refs are owned internally.
 *
 * Framework-specific dependencies (auth state, reachability, diagnostics)
 * are injected via the params object so the hook stays framework-agnostic.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import { isExpectedBackgroundStreamEnd } from "@/domains/chat/utils/background-stream-error.js";
import {
  bucketMessagesAdded,
  recordChatDiagnostic,
  resolvePlatformTag,
} from "@/domains/chat/utils/diagnostics.js";
import { isNativePlatform } from "@/runtime/native-auth.js";
import type {
  ActiveConversationMessagesRefreshResult,
  WebSyncRouter,
} from "@/lib/sync/web-sync-router.js";

import { useConversationListStore } from "@/domains/conversations/conversation-list-store.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import { isSending, useTurnStore } from "@/domains/messaging/turn-store.js";
import { type ChatEventStream, subscribeChatEvents } from "@/domains/chat/api/stream.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Params accepted by {@link useEventStream}. */
export interface UseEventStreamParams {
  /** Current assistant lifecycle state kind. */
  assistantStateKind: string;
  /** Resolved assistant ID (null when not yet loaded). */
  assistantId: string | null;
  /** Currently active conversation key. */
  activeConversationKey: string | null;
  /** Whether the active conversation has been persisted on the server. */
  conversationExistsOnServer: boolean;

  // Shared refs — owned by caller, read/written by multiple hooks
  streamRef: MutableRefObject<ChatEventStream | null>;
  streamEpochRef: MutableRefObject<number>;
  reconcileAfterNextStreamOpenRef: MutableRefObject<boolean>;
  streamContextRef: MutableRefObject<{
    assistantId: string;
    conversationKey: string;
  } | null>;

  // Callbacks from useStreamEventHandler / useMessageReconciliation
  handleStreamEvent: (event: AssistantEvent, epoch: number) => void;
  reconcileActiveConversation: () => Promise<ActiveConversationMessagesRefreshResult>;
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;

  // Reachability
  reachabilityProbe: () => void;
  reachabilityPhase: string;
  reachabilityReset: () => void;

  // Conversation list
  processingSnapshotsRef: MutableRefObject<Map<string, string | undefined>>;

  // Messages
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;

  // Error
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;

  // Stream retry nonce — drives the stream-open effect
  streamRetryNonce: number;
  setStreamRetryNonce: Dispatch<SetStateAction<number>>;

  // Refresh epoch — drives the stream-open effect
  refreshEpoch: number;

  // Sync router ref for watchdog reconnect
  syncRouterRef: MutableRefObject<WebSyncRouter | null>;

  // Conversation list invalidated timer ref — cleaned up on unmount
  conversationListInvalidatedTimerRef: MutableRefObject<ReturnType<
    typeof setTimeout
  > | null>;

  // Auth state for visibility handler
  isLoggedIn: boolean;
  isLoading: boolean;

  // Assistant health check on resume
  checkAssistant: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useEventStream({
  assistantStateKind,
  assistantId,
  activeConversationKey,
  conversationExistsOnServer,
  streamRef,
  streamEpochRef,
  reconcileAfterNextStreamOpenRef,
  streamContextRef,
  handleStreamEvent,
  reconcileActiveConversation,
  startReconciliationLoop,
  cancelReconciliation,
  reachabilityProbe,
  reachabilityPhase,
  reachabilityReset,
  processingSnapshotsRef,
  setMessages,
  setError,
  streamRetryNonce,
  setStreamRetryNonce,
  refreshEpoch,
  syncRouterRef,
  conversationListInvalidatedTimerRef,
  isLoggedIn,
  isLoading,
  checkAssistant,
}: UseEventStreamParams): void {
  // ---- Internal refs (burst-limiter, owned by this hook) ----
  const streamRetryBurstCountRef = useRef(0);
  const streamRetryBurstStartRef = useRef(0);

  // ---- Ref-stabilize unstable callback params ----
  const handleStreamEventRef = useRef(handleStreamEvent);
  handleStreamEventRef.current = handleStreamEvent;

  const reconcileActiveConversationRef = useRef(reconcileActiveConversation);
  reconcileActiveConversationRef.current = reconcileActiveConversation;

  const startReconciliationLoopRef = useRef(startReconciliationLoop);
  startReconciliationLoopRef.current = startReconciliationLoop;

  const reachabilityProbeRef = useRef(reachabilityProbe);
  reachabilityProbeRef.current = reachabilityProbe;

  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;

  const checkAssistantRef = useRef(checkAssistant);
  checkAssistantRef.current = checkAssistant;

  const cancelReconciliationRef = useRef(cancelReconciliation);
  cancelReconciliationRef.current = cancelReconciliation;

  const setStreamRetryNonceRef = useRef(setStreamRetryNonce);
  setStreamRetryNonceRef.current = setStreamRetryNonce;

  const reachabilityResetRef = useRef(reachabilityReset);
  reachabilityResetRef.current = reachabilityReset;

  // --------------------------------------------------------------------------
  // Effect 1: Always-on /events stream
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationKey
    ) {
      return;
    }

    if (!conversationExistsOnServer) {
      return;
    }

    let cancelled = false;
    const capturedAssistantId = assistantId;
    const capturedConversationKey = activeConversationKey;

    const openStream = () => {
      streamContextRef.current = {
        assistantId: capturedAssistantId,
        conversationKey: capturedConversationKey,
      };
      const epoch = ++streamEpochRef.current;
      recordChatDiagnostic("sse_stream_open_start", {
        assistantId: capturedAssistantId,
        conversationKey: capturedConversationKey,
        epoch,
        retryNonce: streamRetryNonce,
      });

      const stream = subscribeChatEvents(
        capturedAssistantId,
        capturedConversationKey,
        (event) => handleStreamEventRef.current(event, epoch),
        (err) => {
          if (cancelled || epoch !== streamEpochRef.current) return;
          recordChatDiagnostic("sse_stream_error", {
            assistantId: capturedAssistantId,
            conversationKey: capturedConversationKey,
            epoch,
            messageLength: err.message.length,
          });
          if (isExpectedBackgroundStreamEnd(err)) {
            Sentry.addBreadcrumb({
              category: "sse.stream",
              level: "warning",
              message: err.message,
              data: { context: "background_stream" },
            });
          } else {
            Sentry.captureException(err, {
              tags: { context: "background_stream" },
            });
          }
          streamRef.current = null;
          useTurnStore.getState().onSessionError();
          {
            const convKey = streamContextRef.current?.conversationKey;
            if (convKey) {
              useConversationListStore.getState().removeProcessingKey(convKey);
              processingSnapshotsRef.current.delete(convKey);
            }
          }
          reachabilityProbeRef.current();
          setMessagesRef.current((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.isStreaming) {
              return [...prev.slice(0, -1), { ...last, isStreaming: false }];
            }
            return prev;
          });
        },
        {
          getActiveTurnSending: () => isSending(useTurnStore.getState()),
          onReconnect: async (cause) => {
            recordChatDiagnostic("sse_stream_reconnect", {
              assistantId: capturedAssistantId,
              conversationKey: capturedConversationKey,
              epoch,
              cause,
            });
            const startedAt = Date.now();
            const syncReconnectResult =
              await syncRouterRef.current?.dispatchReconnect();
            const reconcileResult =
              syncReconnectResult?.activeConversationMessages ??
              (await reconcileActiveConversationRef.current());
            if (cause === "watchdog") {
              const latencyMs = Date.now() - startedAt;
              recordChatDiagnostic("sse_post_watchdog_reconcile_result", {
                assistantId: capturedAssistantId,
                conversationKey: capturedConversationKey,
                epoch,
                latencyMs,
                changed: reconcileResult.changed,
                messagesAdded: reconcileResult.messagesAdded,
                assistantProgress: reconcileResult.assistantProgress,
              });
              Sentry.addBreadcrumb({
                category: "sse.watchdog",
                level: "info",
                message: "post_watchdog_reconcile_result",
                data: {
                  latencyMs,
                  changed: reconcileResult.changed,
                  messagesAdded: reconcileResult.messagesAdded,
                  assistantProgress: reconcileResult.assistantProgress,
                },
              });
              Sentry.captureMessage("sse_post_watchdog_reconcile_result", {
                level: "info",
                tags: {
                  context: "sse_watchdog",
                  platform: resolvePlatformTag(),
                  assistantProgress: String(
                    reconcileResult.assistantProgress,
                  ),
                  rescued: String(reconcileResult.messagesAdded > 0),
                  messagesAddedBucket: bucketMessagesAdded(
                    reconcileResult.messagesAdded,
                  ),
                },
                extra: {
                  latencyMs,
                  messagesAdded: reconcileResult.messagesAdded,
                  changed: reconcileResult.changed,
                  assistantProgress: reconcileResult.assistantProgress,
                  conversationKey: capturedConversationKey,
                  epoch,
                },
              });
            }
          },
        },
      );

      if (cancelled) {
        stream.cancel();
        return;
      }
      streamRef.current = stream;
      recordChatDiagnostic("sse_stream_opened", {
        assistantId: capturedAssistantId,
        conversationKey: capturedConversationKey,
        epoch,
      });
      if (reconcileAfterNextStreamOpenRef.current) {
        reconcileAfterNextStreamOpenRef.current = false;
        void reconcileActiveConversationRef.current();
        startReconciliationLoopRef.current(epoch);
      }
    };

    openStream();

    return () => {
      cancelled = true;
      const cancelledEpoch = streamEpochRef.current;
      streamEpochRef.current += 1;
      recordChatDiagnostic("sse_stream_cancel", {
        assistantId: capturedAssistantId,
        conversationKey: capturedConversationKey,
        epoch: cancelledEpoch,
        nextEpoch: streamEpochRef.current,
      });
      streamRef.current?.cancel();
      streamRef.current = null;
    };
    // streamRetryNonce is intentionally a dependency: bumping it re-opens the
    // SSE stream after a reachability probe confirms the pod is ready again.
  }, [
    assistantStateKind,
    assistantId,
    activeConversationKey,
    conversationExistsOnServer,
    streamRetryNonce,
    refreshEpoch,
  ]);

  // --------------------------------------------------------------------------
  // Effect 2: Reachability retry — re-open stream when probe flips to "ready"
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (reachabilityPhase !== "ready") {
      return;
    }
    const now = Date.now();
    const STREAM_RETRY_BURST_WINDOW_MS = 10_000;
    const STREAM_RETRY_BURST_LIMIT = 3;
    if (
      now - streamRetryBurstStartRef.current >
      STREAM_RETRY_BURST_WINDOW_MS
    ) {
      streamRetryBurstStartRef.current = now;
      streamRetryBurstCountRef.current = 0;
    }
    streamRetryBurstCountRef.current += 1;
    if (streamRetryBurstCountRef.current > STREAM_RETRY_BURST_LIMIT) {
      setErrorRef.current({ message: "Connection lost. Please try again." });
      reachabilityResetRef.current();
      return;
    }
    useTurnStore.getState().resetTurn();
    setErrorRef.current(null);
    reconcileAfterNextStreamOpenRef.current = true;
    setStreamRetryNonceRef.current((value) => value + 1);
  }, [reachabilityPhase]);

  // --------------------------------------------------------------------------
  // Effect 3: Visibility / app-resume handler
  // --------------------------------------------------------------------------
  const stableReconcile = useCallback(
    () => reconcileActiveConversationRef.current(),
    [],
  );

  useEffect(() => {
    if (!isLoggedIn || isLoading) {
      return;
    }

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    let lastResumeAt = 0;
    let lastResumeSignal: string | null = null;
    const RESUME_DEDUP_WINDOW_MS = 1000;

    const tearDownStream = (reason: string) => {
      streamEpochRef.current += 1;
      reconcileAfterNextStreamOpenRef.current = false;
      streamRef.current?.cancel();
      streamRef.current = null;
      cancelReconciliationRef.current();
      clearTimers();
      lastResumeAt = 0;
      lastResumeSignal = null;
      recordChatDiagnostic("resume_stream_teardown", { reason });
    };

    const handleAppResume = (
      signal: "visibility_change_visible" | "app_state_active",
    ) => {
      const now = Date.now();
      if (now - lastResumeAt < RESUME_DEDUP_WINDOW_MS) {
        recordChatDiagnostic("resume_signal_deduped", {
          signal,
          prior_signal: lastResumeSignal,
          ms_since_prior: now - lastResumeAt,
        });
        return;
      }
      lastResumeAt = now;
      lastResumeSignal = signal;
      recordChatDiagnostic("resume_signal_fired", { signal });

      checkAssistantRef.current();

      let didReopen = false;
      const reopenStream = () => {
        if (didReopen) {
          return;
        }
        didReopen = true;
        if (document.visibilityState === "visible") {
          reconcileAfterNextStreamOpenRef.current = true;
          setStreamRetryNonceRef.current((n) => n + 1);
        } else {
          reconcileAfterNextStreamOpenRef.current = false;
        }
      };

      const myTimer = (fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        reopenStream();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (document.visibilityState === "visible") {
            stableReconcile();
          }
        }, 2000);
      }, 5000));

      stableReconcile().finally(() => {
        if (fallbackTimer === myTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        reopenStream();
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        tearDownStream("visibility_change_hidden");
        return;
      }
      handleAppResume("visibility_change_visible");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    let appStateHandle: PluginListenerHandle | null = null;
    let appStateCancelled = false;
    if (isNativePlatform()) {
      import("@capacitor/app")
        .then(({ App }) =>
          App.addListener("appStateChange", ({ isActive }) => {
            if (!isActive) {
              tearDownStream("app_state_inactive");
              return;
            }
            handleAppResume("app_state_active");
          }),
        )
        .then((registered) => {
          if (appStateCancelled) {
            void registered.remove();
            return;
          }
          appStateHandle = registered;
        })
        .catch((error) => {
          recordChatDiagnostic("resume_app_state_register_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimers();
      appStateCancelled = true;
      void appStateHandle?.remove();
    };
  }, [isLoggedIn, isLoading, stableReconcile]);

  // --------------------------------------------------------------------------
  // Effect 4: Unmount cleanup
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      streamRef.current?.cancel();
      cancelReconciliationRef.current();
      if (conversationListInvalidatedTimerRef.current) {
        clearTimeout(conversationListInvalidatedTimerRef.current);
        conversationListInvalidatedTimerRef.current = null;
      }
    };
  }, []);

}
