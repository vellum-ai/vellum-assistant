/**
 * ChatPage — lifecycle guard layer for the chat route.
 *
 * Reads assistant lifecycle state and renders the appropriate screen:
 * - Auth / assistant loading → "Connecting…" placeholder
 * - Error, initializing, cleaning up, etc. → dedicated lifecycle screen
 * - Active (or self-hosted with flag) → mounts `ActiveChatView` for full orchestration
 *
 * By gating at the component boundary, orchestration hooks (SSE, TanStack Query,
 * Zustand subscriptions, keyboard listeners) only mount when the assistant is
 * actually usable — not during setup, cleanup, or error states.
 */

import * as Sentry from "@sentry/react";
import { useCallback, useEffect, useRef } from "react";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useIsSessionInitializing } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { Button } from "@vellumai/design-library";

import { ActiveChatView } from "@/domains/chat/active-chat-view";
import { CleanupScreen } from "@/domains/chat/components/cleanup-screen";
import { SelfHostedScreen } from "@/domains/chat/components/self-hosted-screen";
import { SetupScreen } from "@/domains/chat/components/setup-screen";

export function ChatPage() {
  const isSessionInitializing = useIsSessionInitializing();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const selfHostedChatEnabled = useClientFeatureFlagStore.use.selfHostedAssistant();

  const shouldRenderChat =
    assistantState.kind === "active" ||
    (assistantState.kind === "self_hosted" && selfHostedChatEnabled);

  // Conversation list query — needed for the self-hosted error guard below.
  // TanStack Query deduplicates with the same query in ActiveChatView.
  const {
    isError: conversationListIsError,
    refetch: refetchConversationList,
  } = useConversationListQuery(assistantId, shouldRenderChat);

  const retryAssistant = useCallback(
    () => lifecycleService.retryAssistant(),
    [],
  );

  // -------------------------------------------------------------------------
  // Loading guards — auth / assistant lifecycle not yet resolved
  // -------------------------------------------------------------------------
  const connectingReason = isSessionInitializing
    ? "auth_loading"
    : assistantState.kind === "loading"
      ? "assistant_loading"
      : null;

  const lastConnectingReasonRef = useRef<string | null>(null);
  useEffect(() => {
    if (connectingReason === null) {
      lastConnectingReasonRef.current = null;
      return;
    }
    if (lastConnectingReasonRef.current === connectingReason) return;
    lastConnectingReasonRef.current = connectingReason;
    Sentry.addBreadcrumb({
      category: "chat.connecting",
      level: "info",
      message: "ChatPage rendered Connecting",
      data: {
        reason: connectingReason,
        assistantStateKind: assistantState.kind,
        hasAssistantId: assistantId != null,
      },
    });
  }, [connectingReason, assistantState.kind, assistantId]);

  if (connectingReason !== null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[var(--text-secondary)]">Connecting…</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle guards — non-active assistant states
  // -------------------------------------------------------------------------
  if (assistantState.kind === "error") {
    // Transient (transport-shaped) errors auto-retry in the lifecycle
    // service; the button is just the impatient-user shortcut.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-[var(--text-secondary)]">{assistantState.message}</p>
        <Button variant="primary" onClick={retryAssistant}>
          {assistantState.transient ? "Retry now" : "Try again"}
        </Button>
      </div>
    );
  }

  if (assistantState.kind === "initializing") {
    return <SetupScreen />;
  }

  if (assistantState.kind === "cleaning_up") {
    return <CleanupScreen />;
  }

  if (assistantState.kind === "self_hosted" && !selfHostedChatEnabled) {
    return <SelfHostedScreen />;
  }

  // Self-hosted runtime call failed — land on a terminal error state with a
  // retry button instead of leaving the sidebar + transcript stuck in the
  // seeded `isLoadingHistory` skeleton.
  if (
    assistantState.kind === "self_hosted" &&
    selfHostedChatEnabled &&
    conversationListIsError
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-[var(--text-secondary)]">
          Couldn&apos;t reach your self-hosted assistant. Make sure your
          assistant is running, then try again.
        </p>
        <Button variant="primary" onClick={refetchConversationList}>
          Try again
        </Button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Active chat — all orchestration hooks mount inside ActiveChatView
  // -------------------------------------------------------------------------
  return <ActiveChatView />;
}
