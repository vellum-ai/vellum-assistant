import { useEffect, useRef, type MutableRefObject } from "react";

import type { ReachabilityPhase } from "@/assistant/use-assistant-reachability";
import { consumePendingInitialMessage } from "@/utils/initial-message-launch";

type PendingInitialMessage = {
  conversationId: string;
  content: string;
};

let routedInitialMessage: PendingInitialMessage | null = null;

interface UseInitialMessageLaunchParams {
  assistantId: string | null;
  activeConversationId: string | null;
  reachabilityPhase: ReachabilityPhase;
  pendingInitialMessageRef: MutableRefObject<PendingInitialMessage | null>;
  startNewConversation: (opts?: {
    silent?: boolean;
    initialMessage?: string;
  }) => void;
  sendMessage: (content: string) => Promise<void>;
  probeReachability: () => void;
}

export function useInitialMessageLaunch({
  assistantId,
  activeConversationId,
  reachabilityPhase,
  pendingInitialMessageRef,
  startNewConversation,
  sendMessage,
  probeReachability,
}: UseInitialMessageLaunchParams) {
  const consumedStoredMessageRef = useRef(false);

  useEffect(() => {
    if (consumedStoredMessageRef.current || !assistantId) return;

    const message = consumePendingInitialMessage();
    if (!message) return;

    consumedStoredMessageRef.current = true;
    startNewConversation({ initialMessage: message });

    const pending = pendingInitialMessageRef.current;
    if (pending?.content === message) {
      routedInitialMessage = pending;
    }
  }, [assistantId, pendingInitialMessageRef, startNewConversation]);

  useEffect(() => {
    if (!assistantId || !activeConversationId || !routedInitialMessage) return;
    if (routedInitialMessage.conversationId !== activeConversationId) return;

    pendingInitialMessageRef.current = routedInitialMessage;
    routedInitialMessage = null;
  }, [activeConversationId, assistantId, pendingInitialMessageRef]);

  useEffect(() => {
    if (!assistantId || !activeConversationId || reachabilityPhase !== "idle") {
      return;
    }

    const pending = pendingInitialMessageRef.current;
    if (!pending || pending.conversationId !== activeConversationId) return;

    probeReachability();
  }, [
    activeConversationId,
    assistantId,
    pendingInitialMessageRef,
    probeReachability,
    reachabilityPhase,
  ]);

  useEffect(() => {
    if (!assistantId || !activeConversationId || reachabilityPhase !== "ready") {
      return;
    }

    const pending = pendingInitialMessageRef.current;
    if (!pending || pending.conversationId !== activeConversationId) return;

    pendingInitialMessageRef.current = null;
    void sendMessage(pending.content);
  }, [
    activeConversationId,
    assistantId,
    pendingInitialMessageRef,
    reachabilityPhase,
    sendMessage,
  ]);
}
