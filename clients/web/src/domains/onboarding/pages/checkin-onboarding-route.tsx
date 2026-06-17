/**
 * Route wrapper for the "Let's chat tomorrow" check-in page.
 *
 * SPIKE — checkin-onboarding flow.
 *
 * Sits between the research-onboarding name/occupation form and the chat
 * handoff. The research form stages a `PreChatOnboardingContext` (with the
 * research `initialMessage`) and navigates here instead of handing off
 * directly. Gated by the same default-off `research-onboarding` flag.
 *
 * Here the user can connect Google Calendar (calendar.events only). On a
 * successful grant we fire the Day 2 Check-in prompt into its OWN fresh
 * conversation (`scheduleCheckin`), tag the staged context as Google-connected,
 * and then run the same handoff the research route would have: flip on the
 * focused-presentation flag and navigate to `/assistant?onboarding=1`, where the
 * staged research prompt is auto-sent and rendered chrome-less. Skipping does
 * the handoff without scheduling.
 */

import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate } from "react-router";

import { fetchAssistantIdentity } from "@/assistant/identity";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { scheduleCheckin } from "@/domains/onboarding/checkin-scheduler";
import {
  peekPendingPreChatContext,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { CheckinConnectScreen } from "@/domains/onboarding/screens/checkin-connect-screen";
import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

export function CheckinOnboardingRoute() {
  const navigate = useNavigate();
  const enterFocus = useOnboardingFocusStore.use.enterFocus();
  // Same default-off spike flag as the research front door — this page is the
  // next step in that one flow, not a separate experiment.
  const enabled = useClientFeatureFlagStore.use.researchOnboarding();
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();

  const storeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
  });
  const assistantId = activeAssistant?.id ?? storeAssistantId ?? null;

  // Read (without consuming) the context staged by the research form. The chat
  // surface consumes it on first send, so we must not clear it here.
  const pending = peekPendingPreChatContext();

  function handoffToChat() {
    // Render the handoff chat chrome-less until the user continues out, then
    // mirror the research route's tail: expect a first message, refresh the
    // assistant, hand off to the onboarding chat pipeline.
    enterFocus();
    lifecycleService.markExpectingFirstMessage();
    void lifecycleService.checkAssistant().finally(() => {
      void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
    });
  }

  function handleConnect(scopes: string[]) {
    // Tag the staged context so the onboarding opener knows Google is wired up.
    if (pending) {
      setPendingPreChatContext({
        ...pending,
        googleConnected: true,
        googleScopes: scopes,
      });
    }

    // Best-effort: kick the Day 2 Check-in into its own conversation. We fetch
    // the assistant name for the title, then fire-and-forget so the handoff is
    // never blocked on the scheduling round-trip.
    if (assistantId) {
      void (async () => {
        const assistantName =
          (await fetchAssistantIdentity(assistantId))?.name ?? undefined;
        void scheduleCheckin({
          assistantId,
          userName: pending?.userName,
          assistantName,
        });
      })();
    }

    handoffToChat();
  }

  function handleSkip() {
    handoffToChat();
  }

  function handleBack() {
    void navigate(routes.onboarding.research, { replace: true });
  }

  if (!enabled) {
    // Wait for the async LD fetch before bouncing (see ResearchOnboardingRoute).
    if (!flagsHydrated) return null;
    return <Navigate to={routes.assistant} replace />;
  }

  // Reached without the research form staging context (direct nav / refresh):
  // bounce back to the research front door so the flow starts clean.
  if (!pending) {
    return <Navigate to={routes.onboarding.research} replace />;
  }

  return (
    <CheckinConnectScreen
      assistantId={assistantId ?? ""}
      assistantName={pending.assistantName ?? ""}
      onConnect={handleConnect}
      onSkip={handleSkip}
      onBack={handleBack}
    />
  );
}
