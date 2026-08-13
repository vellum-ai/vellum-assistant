/**
 * Consolidates the three auto-send paths that fire on mount/navigation:
 *
 * 1. **URL prompt** — `?prompt=<text>` triggers an immediate send once an
 *    active conversation exists (used by "Submit Feedback" and similar
 *    deep-link flows). One-shot callers have the `prompt` stripped from the URL
 *    after dispatch so a refresh can't re-send it; relay callers keep theirs to
 *    re-fire on a new token. The send is gated on the target resolving against
 *    live conversation data (see {@link UrlPromptTargetResolution}): a missing
 *    target is refused with a visible error instead of letting the send path
 *    server-mint a new conversation for it.
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
import * as Sentry from "@sentry/react";

import type { SetURLSearchParams } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import type {
  ReachabilityProbeOptions,
  ReachabilityState,
} from "@/assistant/use-assistant-reachability";

/**
 * Where the active conversation stands against live conversation data, for
 * gating the URL `?prompt=` auto-send:
 *
 * - `"unresolved"`: the conversation list has not loaded yet; hold the send
 *   until it has (the effect re-runs when this settles).
 * - `"exists"`: the id is a known conversation row or a registered
 *   client-side draft; safe to send.
 * - `"missing"`: the target definitively does not exist (a settled 404 on
 *   its row) and it is no registered draft. The send must be dropped: the
 *   send path treats an unknown id as a draft and server-mints a NEW
 *   conversation, so relaying would silently send the message outside the
 *   chat the caller targeted (a conversation deleted since the relay URL
 *   was built, or an id from another assistant).
 */
export type UrlPromptTargetResolution = "unresolved" | "exists" | "missing";

export interface UseAutoSendEffectsOptions {
  assistantId: string | null;
  activeConversationId: string | null;
  urlPromptTargetResolution: UrlPromptTargetResolution;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  sendMessage: (
    content: string,
    attachments?: never[],
    opts?: { hidden?: boolean; scripted?: boolean },
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
  urlPromptTargetResolution,
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
    if (!prompt || !activeConversationId) {
      return;
    }
    // Hold until the target is resolvable, and refuse a missing target: see
    // {@link UrlPromptTargetResolution} for why sending anyway would create
    // a new conversation instead of failing.
    if (urlPromptTargetResolution === "unresolved") {
      return;
    }
    if (urlPromptTargetResolution === "missing") {
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "warning",
        message:
          "?prompt= target conversation not found; dropping the auto-send",
      });
      toast.error("Couldn't find that chat, so the message wasn't sent.");
      // Strip the whole relay payload so a reload or back-navigation cannot
      // retry a send that was just refused.
      setSearchParams(
        (prev) => {
          prev.delete("prompt");
          prev.delete("relay");
          return prev;
        },
        { replace: true },
      );
      return;
    }
    // A relay token makes each dispatch unique so repeated identical prompts
    // re-fire; one-shot callers (deep links, doc feedback) omit it and dedupe
    // on the prompt text.
    const relayToken = searchParams.get("relay");
    const key = `${activeConversationId}:${relayToken ?? prompt}`;
    if (promptConsumedRef.current === key) {
      return;
    }
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
  }, [
    searchParams,
    setSearchParams,
    activeConversationId,
    urlPromptTargetResolution,
    sendMessage,
  ]);

  // 2. Pre-chat reachability probe — eagerly start the probe cycle.
  useEffect(() => {
    if (!assistantId) {
      return;
    }
    if (!getPendingInitialMessageRef.current()) {
      return;
    }
    if (reachabilityPhase === "idle") {
      reachabilityProbe({ mode: "background" });
    }
  }, [assistantId, reachabilityPhase, reachabilityProbe]);

  // 3. Onboarding initial message — fires once when daemon is reachable.
  const initialMessageConsumedRef = useRef(false);
  useEffect(() => {
    if (
      initialMessageConsumedRef.current ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    if (reachabilityPhase !== "ready") {
      return;
    }
    const message = getPendingInitialMessageRef.current();
    if (!message) {
      return;
    }
    initialMessageConsumedRef.current = true;
    const hidden = getPendingInitialMessageHiddenRef.current?.() ?? false;
    // Every message that reaches here is auto-sent by an onboarding flow, not
    // typed: the research prompt, the "Let's chat" kickoff greeting, or the
    // legacy pre-chat bootstrap. Marked unconditionally rather than keyed off
    // `hidden`, because the two are independent: the research prompt is
    // visible AND scripted.
    //
    // Note this is the pre-chat staged message only. The `?prompt=` auto-send
    // above is deliberately NOT marked: those are user-initiated (quick input,
    // a check-in CTA the user clicked), and the analytics classifier does not
    // treat them as scripted either.
    void sendMessage(message, [], { hidden, scripted: true });
  }, [activeConversationId, assistantId, reachabilityPhase, sendMessage]);
}
