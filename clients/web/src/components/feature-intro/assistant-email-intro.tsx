import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useAssistantInboxState } from "@/domains/assistant-inbox/hooks/use-assistant-inbox-state";
import { useFeatureIntroSeen } from "@/hooks/use-feature-intro-seen";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

import { AssistantEmailIntroModal } from "./assistant-email-intro-modal";
import { resolveAssistantEmailIntro } from "./resolve-assistant-email-intro";

interface GateProps {
  assistantId: string;
  markSeen: () => void;
}

/**
 * The half that costs requests, mounted only while the intro can still
 * show: reads the inbox's state the way the inbox page does and draws the
 * modal for the two states that have something to announce.
 */
function AssistantEmailIntroGate({ assistantId, markSeen }: GateProps) {
  const navigate = useNavigate();
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();
  const inboxEnabled = useClientFeatureFlagStore.use.assistantInbox();
  const focused = useOnboardingFocusStore.use.focused();
  const checkinPending = useOnboardingFocusStore.use.checkinPending();
  const identityName = useAssistantIdentityStore.use.name();
  const state = useAssistantInboxState(assistantId, identityName ?? "");

  const intro = resolveAssistantEmailIntro({
    seen: false,
    flagsHydrated,
    inboxEnabled,
    onboardingBusy: focused || checkinPending,
    status: state.status,
  });

  const leaveFor = useCallback(
    (path: string) => {
      markSeen();
      void navigate(path);
    },
    [markSeen, navigate],
  );

  if (intro === null) {
    return null;
  }
  return (
    <AssistantEmailIntroModal
      open
      onOpenChange={(open) => {
        if (!open) {
          markSeen();
        }
      }}
      assistantId={assistantId}
      assistantName={state.assistantName}
      rootDomain={state.rootDomain}
      locked={intro === "locked"}
      onUpgrade={() => leaveFor(routes.plans)}
      onSeePlans={() => leaveFor(routes.plans)}
      onSetUp={() => leaveFor(routes.assistantInbox)}
    />
  );
}

/**
 * The one-time intro to Assistant Email, mounted once in the chat layout so
 * it meets the user on opening the app. Reads nothing but the device's
 * memory until it knows the intro is still owed, so a device that has seen
 * it pays no query for it; the flag and the inbox's own state then decide
 * whether there is anything to announce (see `resolveAssistantEmailIntro`).
 * Dismissing it by any route marks it seen, and it never returns.
 */
export function AssistantEmailIntro() {
  const { seen, markSeen } = useFeatureIntroSeen("assistant-email");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const inboxEnabled = useClientFeatureFlagStore.use.assistantInbox();
  if (seen || !inboxEnabled || assistantId === null) {
    return null;
  }
  return (
    <AssistantEmailIntroGate assistantId={assistantId} markSeen={markSeen} />
  );
}
