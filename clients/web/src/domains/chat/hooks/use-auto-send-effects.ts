/**
 * Consolidates the three auto-send paths that fire on mount/navigation:
 *
 * 1. **URL prompt** — `?prompt=<text>` triggers an immediate send once an
 *    active conversation exists (used by "Submit Feedback" and similar
 *    deep-link flows). One-shot callers have the `prompt` stripped from the URL
 *    after dispatch so a refresh can't re-send it; relay callers keep theirs to
 *    re-fire on a new token.
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

import type { SetURLSearchParams } from "react-router";

import type {
  ReachabilityProbeOptions,
  ReachabilityState,
} from "@/assistant/use-assistant-reachability";

export interface UseAutoSendEffectsOptions {
  assistantId: string | null;
  activeConversationId: string | null;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  sendMessage: (
    content: string,
    attachments?: never[],
    opts?: { hidden?: boolean },
  ) => Promise<void>;
  reachabilityPhase: ReachabilityState["phase"];
  reachabilityProbe: (options?: ReachabilityProbeOptions) => void;
  /** Reads the staged pre-chat initial message from sessionStorage. */
  getPendingInitialMessage: () => string | undefined;
  /**
   * Whether the staged pre-chat initial message should be sent hidden — driving
   * the assistant's reply but rendering no user bubble (used by the
   * research-onboarding "Let's chat" handoff for a proactive greeting).
   */
  getPendingInitialMessageHidden?: () => boolean;
}

export function useAutoSendEffects({
  assistantId,
  activeConversationId,
  searchParams,
  setSearchParams,
  sendMessage,
  reachabilityPhase,
  reachabilityProbe,
  getPendingInitialMessage,
  getPendingInitialMessageHidden,
}: UseAutoSendEffectsOptions): void {
  const getPendingInitialMessageRef = useRef(getPendingInitialMessage);
  useLayoutEffect(() => {
    getPendingInitialMessageRef.current = getPendingInitialMessage;
  });
  const getPendingInitialMessageHiddenRef = useRef(
    getPendingInitialMessageHidden,
  );
  useLayoutEffect(() => {
    getPendingInitialMessageHiddenRef.current = getPendingInitialMessageHidden;
  });
  // 1. URL ?prompt= auto-send.
  // Keyed by conversationId + prompt so the same text sent to different
  // draft conversations (e.g. repeated quick-input submissions) isn't deduped.
  const promptConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    const prompt = searchParams.get("prompt");
    if (!prompt || !activeConversationId) return;
    // A relay token makes each dispatch unique so repeated identical prompts
    // re-fire; one-shot callers (deep links, doc feedback) omit it and dedupe
    // on the prompt text.
    const relayToken = searchParams.get("relay");
    const key = `${activeConversationId}:${relayToken ?? prompt}`;
    if (promptConsumedRef.current === key) return;
    promptConsumedRef.current = key;
    void sendMessage(prompt);
    // One-shot callers (no relay token) dedupe only on this component ref,
    // which resets on refresh/remount — so a deep link like the Day-2 check-in
    // (`?prompt=…&vref=…`) would re-send on reload. Strip the prompt once
    // dispatched so the send is durably once-only. Relay callers intentionally
    // re-fire (each new token is a fresh dispatch), so leave their URL intact.
    if (!relayToken) {
      setSearchParams(
        (prev) => {
          prev.delete("prompt");
          return prev;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams, activeConversationId, sendMessage]);

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
    const hidden = getPendingInitialMessageHiddenRef.current?.() ?? false;
    void sendMessage(message, [], { hidden });
  }, [activeConversationId, assistantId, reachabilityPhase, sendMessage]);
}
