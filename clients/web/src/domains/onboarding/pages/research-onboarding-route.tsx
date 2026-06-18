/**
 * Route wrapper for the research-onboarding front door.
 *
 * SPIKE — research-onboarding flow.
 *
 * Collects first/last/occupation, stages a pre-chat context whose
 * `initialMessage` is the "research me" prompt, flips on the focused
 * presentation flag, and hands off to the existing
 * `/assistant?onboarding=1` pipeline. From there the standard machinery
 * hatches the assistant, mints a conversation, auto-sends the research
 * prompt, and streams the reply — rendered chrome-less by `ChatLayout`
 * because the focus flag is set. The user reads the output, then clicks
 * "Continue" (in `ChatLayout`) to drop into the full workspace on the
 * very same conversation.
 */

import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import {
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import { buildResearchPrompt } from "@/domains/onboarding/research-prompt";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import {
  ResearchOnboardingScreen,
  type ResearchOnboardingValues,
} from "@/domains/onboarding/screens/research-onboarding-screen";

export function ResearchOnboardingRoute() {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const enterFocus = useOnboardingFocusStore.use.enterFocus();
  const exitFocus = useOnboardingFocusStore.use.exitFocus();
  // Belt-and-suspenders gate: the spike lives at a dedicated path AND behind
  // this flag (off by default; enable locally via the feature-flags panel).
  const enabled = useClientFeatureFlagStore.use.researchOnboarding();

  // Landing on the form means a fresh run — clear any stale focus state left
  // behind by an abandoned previous attempt so the form itself never renders
  // chrome-less.
  useEffect(() => {
    exitFocus();
  }, [exitFocus]);

  function handleSubmit({
    firstName,
    lastName,
    occupation,
  }: ResearchOnboardingValues) {
    const fullName = [firstName.trim(), lastName.trim()]
      .filter(Boolean)
      .join(" ");

    const context: PreChatOnboardingContext = {
      // Required handoff fields — no tool/task/tone collection in this flow.
      tools: [],
      tasks: [],
      tone: DEFAULT_GROUP_ID,
      ...(fullName ? { userName: fullName } : {}),
      ...(occupation.trim() ? { occupation: occupation.trim() } : {}),
      // The auto-sent first message: kick off the research pass.
      initialMessage: buildResearchPrompt({ firstName, lastName, occupation }),
    };

    setPendingPreChatContext(context);

    // Render the handoff chat chrome-less until the user continues out.
    enterFocus();

    // Mirror `PreChatFlow.completeFlow`: tell the lifecycle service to expect a
    // first message (drives the auto-greet gate), refresh the assistant, then
    // hand off to the onboarding chat pipeline.
    lifecycleService.markExpectingFirstMessage();
    void lifecycleService.checkAssistant().finally(() => {
      void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
    });
  }

  if (!enabled) {
    return <Navigate to={routes.assistant} replace />;
  }

  return (
    <ResearchOnboardingScreen
      initialFirstName={user?.firstName ?? ""}
      initialLastName={user?.lastName ?? ""}
      onSubmit={handleSubmit}
    />
  );
}
