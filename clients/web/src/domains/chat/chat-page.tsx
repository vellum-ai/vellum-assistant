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
import {
  markBoot,
  markBootBlocked,
  type BootBlockedReason,
} from "@/lib/telemetry/boot-telemetry";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { Button } from "@vellumai/design-library";

import { ActiveChatView } from "@/domains/chat/active-chat-view";
import { CleanupScreen } from "@/domains/chat/components/cleanup-screen";
import { SelfHostedScreen } from "@/domains/chat/components/self-hosted-screen";
import { SetupScreen } from "@/domains/chat/components/setup-screen";
import { useStuckConnecting } from "@/domains/chat/hooks/use-stuck-connecting";

export function ChatPage() {
  const isSessionInitializing = useIsSessionInitializing();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const selfHostedChatEnabled =
    useClientFeatureFlagStore.use.selfHostedAssistant();

  const shouldRenderChat =
    assistantState.kind === "active" ||
    (assistantState.kind === "self_hosted" && selfHostedChatEnabled);

  // Conversation list query — needed for the self-hosted error guard below.
  // TanStack Query deduplicates with the same query in ActiveChatView.
  const { isError: conversationListIsError, refetch: refetchConversationList } =
    useConversationListQuery(assistantId, shouldRenderChat);

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

  // Watchdog: connecting has no natural failure surface, so a wedged auth
  // init or lifecycle probe would spin forever. Escalate to a retry screen
  // after a bounded wait (and capture the episode to Sentry).
  const { connectingStuck, resetStuckConnecting } =
    useStuckConnecting(connectingReason);
  const retryStuckConnecting = useCallback(() => {
    resetStuckConnecting();
    lifecycleService.retryAssistant();
  }, [resetStuckConnecting]);

  // Boot telemetry terminal outcome, or `null` while the page is still
  // resolving. A boot in flight must be neither a success nor a failure until
  // it settles, and "still resolving" deliberately covers more than the
  // "Connecting…" placeholder: `initializing` (first-run setup),
  // `cleaning_up` (teardown), and a `transient` lifecycle error all recover
  // into chat on their own, so reporting them as terminal would count the same
  // first-run boot in both the numerator and the denominator of the success
  // rate. If one of them never clears, the boot-telemetry deadline reports the
  // waterfall as unsettled, which is the accurate signal.
  const selfHostedBlocked =
    assistantState.kind === "self_hosted" &&
    (!selfHostedChatEnabled || conversationListIsError);
  // `connectingStuck` is only terminal while the page is STILL connecting.
  // `useStuckConnecting` clears its flag from an effect, so on the commit where
  // `connectingReason` flips to null the flag is briefly still true; reading it
  // unconditionally filed every recovered boot as a permanent failure, and the
  // retry button did the same. That contradicted the rule one line down, where
  // states the app recovers from leave the boot unsettled rather than failing
  // it. A boot that took 30s and then worked is slow, and the marks say so; it
  // is not a boot that never got there.
  const bootOutcome: BootBlockedReason | "interactive" | null =
    connectingStuck && connectingReason !== null
      ? "stuck_connecting"
      : assistantState.kind === "error" && !assistantState.transient
        ? "lifecycle_error"
        : selfHostedBlocked
          ? "self_hosted_unavailable"
          : shouldRenderChat
            ? "interactive"
            : null;

  useEffect(() => {
    if (bootOutcome === null) {
      return;
    }
    if (bootOutcome === "interactive") {
      markBoot("chat_interactive");
      return;
    }
    markBootBlocked(bootOutcome);
  }, [bootOutcome]);

  const lastConnectingReasonRef = useRef<string | null>(null);
  useEffect(() => {
    if (connectingReason === null) {
      lastConnectingReasonRef.current = null;
      return;
    }
    if (lastConnectingReasonRef.current === connectingReason) {
      return;
    }
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
    if (connectingStuck) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-[var(--text-secondary)]">
            Still connecting to your assistant — something seems stuck. Try
            again, or refresh the page if this keeps happening.
          </p>
          <Button variant="primary" onClick={retryStuckConnecting}>
            Try again
          </Button>
        </div>
      );
    }
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
  return (
    <>
      <span data-slot="active-chat-view" hidden />
      <ActiveChatView />
    </>
  );
}
