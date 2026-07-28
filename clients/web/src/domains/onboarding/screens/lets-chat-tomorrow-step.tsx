/**
 * "I'll check in with you tomorrow" step content — offer to drop a Day-2
 * follow-up on the user's calendar, framed as the assistant checking in (not as
 * connecting an integration), since chatting continues right after onboarding.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only (the toned backdrop sits behind, so the assistant color, its
 * eyes, and the tone characters carry over). "Setup check-in" runs the
 * real managed Google Calendar OAuth (calendar.events + identity scopes only)
 * via `useGoogleCalendarConnect`; on a successful grant the parent route fires
 * the Day-2 check-in prompt (`scheduleCheckin`) and advances. "Skip for now"
 * just advances. The connect button waits on the background hatch being fully
 * READY (active + healthz-passed), not just having an id — `scheduleCheckin`
 * talks to the daemon, so an OAuth completed against a not-yet-reachable daemon
 * would silently no-op while the flow advanced to "Meeting Created!".
 */

import { Loader2 } from "lucide-react";

import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useGoogleCalendarConnect } from "@/domains/onboarding/hooks/use-google-calendar-connect";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

interface LetsChatTomorrowStepProps {
  /** Hatched assistant id; null until the background hatch resolves. */
  assistantId: string | null;
  /** True once the hatch is fully healthy (daemon reachable), not just hatched. */
  assistantReady: boolean;
  /** Fired once the Google Calendar grant lands, with the scopes granted. */
  onConnected: (scopes: string[]) => void;
  onSkip: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
  /**
   * True when a prior grant connected without the calendar.events scope (the
   * calendar checkbox was left unticked on Google's consent screen). Surfaces an
   * inline re-prompt instead of advancing to a confirmation that never booked.
   */
  missingCalendarScope?: boolean;
  /** Clears the missing-scope re-prompt as the user starts a fresh attempt. */
  onRetry?: () => void;
  /**
   * Set when the background hatch hit a terminal failure or timeout. The hatch
   * never reaches ready, so the connect action stays disabled — keep "Skip for
   * now" visible so the user can continue without the check-in instead of being
   * trapped behind a spinner that never resolves.
   */
  hatchError?: string | null;
}

export function LetsChatTomorrowStep({
  assistantId,
  assistantReady,
  onConnected,
  onSkip,
  onBack,
  onForward,
  missingCalendarScope = false,
  onRetry,
  hatchError = null,
}: LetsChatTomorrowStepProps) {
  const tone = useOnboardingTone();
  const { handleConnect, oauthInProgress } = useGoogleCalendarConnect({
    assistantId: assistantId ?? "",
    onConnect: onConnected,
  });
  // Clear any stale re-prompt before reopening the consent popup so the message
  // reflects only the latest attempt.
  const handleConnectClick = () => {
    onRetry?.();
    handleConnect();
  };
  // Wait for full readiness (not just an id): the post-OAuth `scheduleCheckin`
  // hits the daemon, which may not be reachable until healthz passes.
  const waitingForAssistant = !assistantId || !assistantReady;
  const connectDisabled = waitingForAssistant || oauthInProgress;

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[26%] flex w-[360px] -translate-x-1/2 flex-col items-center gap-5 text-center">
        <h1
          className="text-[2.6rem] leading-tight"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {waitingForAssistant
            ? "Waking up"
            : missingCalendarScope
              ? "Access not enabled"
              : "Let me make this easy"}
        </h1>
        <p className="text-[16px]" style={{ color: tone.fgMuted }}>
          {waitingForAssistant
            ? "Your assistant is getting ready"
            : missingCalendarScope
              ? "Check the box next to the Google Calendar permission so I can book the check-in."
              : "Connect your Google Calendar so I can find time to check in and start helping."}
        </p>

        <div className="mt-6 flex w-[234px] flex-col items-center gap-4">
          <button
            type="button"
            onClick={handleConnectClick}
            disabled={connectDisabled}
            className="flex cursor-pointer h-11 w-full items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
              color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
            }}
          >
            {waitingForAssistant ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Starting assistant…
              </>
            ) : oauthInProgress ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Waiting for authorization…
              </>
            ) : missingCalendarScope ? (
              "Try again"
            ) : (
              "Connect Calendar →"
            )}
          </button>
          {/* Skip sits directly under the connect button. Hidden while the
              assistant is still waking up (nothing to skip yet), but kept
              available when the hatch has failed so the user is never trapped
              behind a connect button that can never enable. */}
          {(!waitingForAssistant || hatchError) && (
            <button
              type="button"
              onClick={onSkip}
              disabled={oauthInProgress}
              className="cursor-pointer text-body-small-default transition-opacity hover:opacity-100 disabled:opacity-60"
              style={{ color: tone.fgMuted }}
            >
              Skip for now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
