/**
 * Route wrapper for the research-onboarding front door.
 *
 * SPIKE — research-onboarding flow.
 *
 * Collects first/last/occupation, stages a pre-chat context whose
 * `initialMessage` is the "research me" prompt, then hands off to the
 * "Let's chat tomorrow" check-in page (`/assistant/onboarding/checkin`).
 * The check-in page connects Google Calendar and then runs the handoff to
 * the existing `/assistant?onboarding=1` pipeline, where the standard
 * machinery hatches the assistant, mints a conversation, auto-sends the
 * research prompt, and streams the reply — rendered chrome-less by
 * `ChatLayout` because the focus flag is set. The user reads the output,
 * then clicks "Continue" (in `ChatLayout`) to drop into the full workspace
 * on the very same conversation.
 */

import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router";

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
  const exitFocus = useOnboardingFocusStore.use.exitFocus();
  // Belt-and-suspenders gate: the spike lives at a dedicated path AND behind
  // this flag (off by default; enable locally via the feature-flags panel).
  const enabled = useClientFeatureFlagStore.use.researchOnboarding();
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();

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

    // Detour to the "Let's chat tomorrow" check-in page, which connects Google
    // Calendar and then performs the handoff to `/assistant?onboarding=1`.
    void navigate(routes.onboarding.checkin);
  }

  if (!enabled) {
    // A cold load starts with the default-off value while the LD flag is still
    // being fetched; wait for that response before bouncing so a flag that's
    // actually `true` isn't redirected away on first render.
    if (!flagsHydrated) return null;
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
