/**
 * "Let's chat tomorrow" Google Calendar step, shown as the first screen of the
 * focused research-onboarding flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * Lives at the top level (not in `domains/chat` or `domains/onboarding`) because
 * it composes the onboarding `CheckinConnectScreen` over the chat-owned focused
 * research output — a cross-domain seam that belongs in shared/page-level code.
 * `ChatLayout` mounts it alongside the research overlay; it self-gates on
 * `checkinPending` and renders above the research results (which stream in
 * behind it) until the user connects or skips.
 *
 * On connect it fires the Day-2 Check-in into its own conversation
 * (best-effort) and clears the pending flag, revealing the research results.
 */

import { fetchAssistantIdentity } from "@/assistant/identity";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { scheduleCheckin } from "@/domains/onboarding/checkin-scheduler";
import { CheckinConnectScreen } from "@/domains/onboarding/screens/checkin-connect-screen";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";

export function OnboardingCheckinOverlay() {
  const checkinPending = useOnboardingFocusStore.use.checkinPending();
  const checkinUserName = useOnboardingFocusStore.use.checkinUserName();
  const endCheckin = useOnboardingFocusStore.use.endCheckin();
  const assistantId = useActiveAssistantId();

  if (!checkinPending) return null;

  const handleConnect = () => {
    if (assistantId) {
      // Best-effort, fire-and-forget: resolve the assistant name for the event
      // title, then schedule the check-in in its own conversation. Never blocks
      // revealing the research results.
      void (async () => {
        const assistantName =
          (await fetchAssistantIdentity(assistantId))?.name ?? undefined;
        void scheduleCheckin({
          assistantId,
          userName: checkinUserName ?? undefined,
          assistantName,
        });
      })();
    }
    endCheckin();
  };

  // Above the research overlay (z-50) so it fully covers the streaming results.
  return (
    <div className="fixed inset-0 z-[60]">
      <CheckinConnectScreen
        assistantId={assistantId ?? ""}
        assistantName=""
        onConnect={handleConnect}
        onSkip={endCheckin}
      />
    </div>
  );
}
