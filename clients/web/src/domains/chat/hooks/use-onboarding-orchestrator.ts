/**
 * Consolidates onboarding state, refs, and effects that previously lived
 * as scattered pieces in ActiveChatView.
 *
 * Owns:
 * - `pendingOnboardingContextRef` — pre-chat context for the first send
 * - `onboardingDraftConversationIdRef` — draft conversation created during onboarding
 * - `didOnboarding` / `onboardingConversationId` / `onboardingTasksEmpty` — lifecycle flags
 * - `?onboarding=1` search-param signal consumption effect
 * - `sessionStorage` tasks-empty derivation
 *
 * Does NOT own:
 * - Auto-send of the initial message (depends on `sendMessage` from `useSendMessage`,
 *   which itself consumes the refs this hook creates — keeping auto-send here
 *   would create a circular initialization dependency)
 * - Reachability probe (same reason — depends on reachability from a sibling hook)
 *
 * Returns:
 * - Refs consumed by `useSendMessage` and `useConversationLoader` (shared ownership)
 * - Flags consumed by `ChatMainPanel` via props
 */

import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useConversationStore } from "@/stores/conversation-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { type PreChatOnboardingContext } from "@/domains/onboarding/prechat";
import {
  isInChatTourOn,
  readInChatTourVariant,
} from "@/domains/chat/in-chat-onboarding/in-chat-tour-flag";
import {
  emitInChatTourExposed,
  emitInChatTourStarted,
} from "@/domains/chat/in-chat-onboarding/tour-telemetry";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { routes } from "@/utils/routes";

export interface UseOnboardingOrchestratorResult {
  /** Whether the user arrived via the onboarding flow. */
  didOnboarding: boolean;
  /** Whether the user skipped task selection during prechat. */
  onboardingTasksEmpty: boolean;
  /** The draft conversation created for the onboarding flow. */
  onboardingConversationId: string | null;
  /** Shared with `useSendMessage` — pre-chat context for the first send. */
  pendingOnboardingContextRef: MutableRefObject<PreChatOnboardingContext | null>;
  /** Shared with `useSendMessage` + `useConversationLoader`. */
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;
}

export function useOnboardingOrchestrator(): UseOnboardingOrchestratorResult {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();

  const pendingOnboardingContextRef = useRef<PreChatOnboardingContext | null>(null);
  const onboardingDraftConversationIdRef = useRef<string | null>(null);
  const [didOnboarding, setDidOnboarding] = useState(false);
  const [onboardingTasksEmpty, setOnboardingTasksEmpty] = useState(false);
  const [onboardingConversationId, setOnboardingConversationId] = useState<string | null>(null);

  // Consume the `?onboarding=1` signal left by `/onboarding/hatching` when
  // it forwards the user after a successful hatch. Owns the post-hatch
  // draft conversation creation + redirect; the auto-greet gate itself
  // is driven by `lifecycleService.expectingFirstMessage` (set by the
  // hatching screens before they navigate). The flag is stripped from
  // the URL immediately so a page refresh doesn't re-trigger the greet.
  useEffect(() => {
    if (searchParams.get("onboarding") !== "1") return;
    setDidOnboarding(true);
    const draftId =
      onboardingDraftConversationIdRef.current ?? createDraftConversationId();
    onboardingDraftConversationIdRef.current = draftId;
    setOnboardingConversationId(draftId);
    useConversationStore.getState().setActiveConversationId(draftId);
    // The in-chat-onboarding-tour experiment — DESKTOP ONLY: phone-width
    // viewports and the native shell get neither the tour (its takeover
    // is built around the desktop sidebar/composer layout) nor ANY of its
    // telemetry. Skipping the exposure event too is deliberate: mobile
    // sessions must stay out of both cohorts, or arm comparisons would be
    // diluted by users who could never see the tour. On desktop, an
    // exposure event fires for BOTH arms at the hand-off (control emits
    // nothing else, and the funnel needs its rows for comparison), then
    // the `tour` arm plays the eyes-led tour over the workspace the user
    // just landed in. The arm is read at consumption time — flags
    // hydrated long ago during the onboarding flow itself, and the
    // signal is one-shot.
    if (!isMobile && !isNative) {
      emitInChatTourExposed();
      if (isInChatTourOn(readInChatTourVariant())) {
        useInChatOnboardingStore.getState().startPrototype();
        emitInChatTourStarted("auto");
      }
    }
    void navigate(routes.conversation(draftId), { replace: true });
  }, [searchParams, navigate, isMobile, isNative]);

  // Derive onboardingTasksEmpty from the pending context in sessionStorage.
  // Runs once on mount — if initial message key is present, this is an
  // onboarding mount, so peek at the context for the tasks-empty flag.
  useEffect(() => {
    try {
      const raw = globalThis.sessionStorage?.getItem("onboarding.prechat.pendingContext");
      if (!raw) return;
      const ctx = JSON.parse(raw) as { tasks?: string[] };
      if (Array.isArray(ctx.tasks) && ctx.tasks.length === 0) {
        setOnboardingTasksEmpty(true);
      }
    } catch {
      // Storage or parse failure — ignore.
    }
  }, []);

  return {
    didOnboarding,
    onboardingTasksEmpty,
    onboardingConversationId,
    pendingOnboardingContextRef,
    onboardingDraftConversationIdRef,
  };
}
