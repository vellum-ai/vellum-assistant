/**
 * Consolidates the three auto-send paths that fire on mount/navigation:
 *
 * 1. **URL prompt** — `?prompt=<text>` triggers an immediate send once an
 *    active conversation exists (used by "Submit Feedback" and similar
 *    deep-link flows). Consumed exactly once per distinct `prompt` value.
 *
 * 2. **Pre-chat reachability probe** — when a pending onboarding message
 *    exists in sessionStorage, kicks off a background reachability probe
 *    immediately instead of waiting for a 502 from the conversation list
 *    query to trigger the unreachable-bus.
 *
 * 3. **Onboarding initial message** — once the daemon reports "ready",
 *    reads the staged pre-chat context from sessionStorage and auto-sends
 *    the initial message. Consumed exactly once per mount.
 */

import { useEffect, useLayoutEffect, useRef } from "react";

import type {
  ReachabilityProbeOptions,
  ReachabilityState,
} from "@/assistant/use-assistant-reachability";

export interface UseAutoSendEffectsOptions {
  assistantId: string | null;
  activeConversationId: string | null;
  searchParams: URLSearchParams;
  sendMessage: (content: string) => Promise<void>;
  reachabilityPhase: ReachabilityState["phase"];
  reachabilityProbe: (options?: ReachabilityProbeOptions) => void;
  /** Reads the staged pre-chat initial message from sessionStorage. */
  getPendingInitialMessage: () => string | undefined;
}

export function useAutoSendEffects({
  assistantId,
  activeConversationId,
  searchParams,
  sendMessage,
  reachabilityPhase,
  reachabilityProbe,
  getPendingInitialMessage,
}: UseAutoSendEffectsOptions): void {
  const getPendingInitialMessageRef = useRef(getPendingInitialMessage);
  useLayoutEffect(() => {
    getPendingInitialMessageRef.current = getPendingInitialMessage;
  });
  // 1. URL ?prompt= auto-send.
  // Keyed by conversationId + prompt so the same text sent to different
  // draft conversations (e.g. repeated quick-input submissions) isn't deduped.
  const promptConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    const prompt = searchParams.get("prompt");
    if (!prompt || !activeConversationId) return;
    const key = `${activeConversationId}:${prompt}`;
    if (promptConsumedRef.current === key) return;
    promptConsumedRef.current = key;
    void sendMessage(prompt);
  }, [searchParams, activeConversationId, sendMessage]);

  // 2. Pre-chat reachability probe — eagerly start the probe cycle.
  useEffect(() => {
    if (!assistantId) return;
    if (!getPendingInitialMessageRef.current()) return;
    if (reachabilityPhase === "idle") {
      reachabilityProbe({ mode: "background" });
    }
  }, [assistantId, reachabilityPhase, reachabilityProbe]);

  // 3. Onboarding initial message — fires once when daemon is reachable.
  const initialMessageConsumedRef = useRef(false);
  useEffect(() => {
    if (initialMessageConsumedRef.current || !assistantId || !activeConversationId) return;
    if (reachabilityPhase !== "ready") return;
    const message = getPendingInitialMessageRef.current();
    if (!message) return;
    initialMessageConsumedRef.current = true;
    void sendMessage(message);
  }, [activeConversationId, assistantId, reachabilityPhase, sendMessage]);
}
