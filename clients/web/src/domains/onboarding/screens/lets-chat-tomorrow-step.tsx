/**
 * "I'll check in with you tomorrow" step content — offer to drop a Day-2
 * follow-up on the user's calendar, framed as the assistant checking in (not as
 * connecting an integration), since chatting continues right after onboarding.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only (the toned backdrop sits behind, so the assistant color, its
 * eyes, and the tone characters carry over). "Add to Google Calendar" runs the
 * real managed Google Calendar OAuth (calendar.events + identity scopes only)
 * via `useGoogleCalendarConnect`; on a successful grant the parent route fires
 * the Day-2 check-in prompt (`scheduleCheckin`) and advances. "Skip for now"
 * just advances. The connect button waits on the background hatch — it's
 * disabled until the assistant id is available.
 */

import { Loader2 } from "lucide-react";

import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useGoogleCalendarConnect } from "@/domains/onboarding/hooks/use-google-calendar-connect";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

interface LetsChatTomorrowStepProps {
  /** Hatched assistant id; null until the background hatch is ready. */
  assistantId: string | null;
  /** Fired once the Google Calendar grant lands, with the scopes granted. */
  onConnected: (scopes: string[]) => void;
  onSkip: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}

export function LetsChatTomorrowStep({
  assistantId,
  onConnected,
  onSkip,
  onBack,
  onForward,
}: LetsChatTomorrowStepProps) {
  const tone = useOnboardingTone();
  const { handleConnect, oauthInProgress } = useGoogleCalendarConnect({
    assistantId: assistantId ?? "",
    onConnect: onConnected,
  });
  // The assistant must be hatched before we can start its OAuth flow.
  const connectDisabled = !assistantId || oauthInProgress;

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[26%] flex w-[360px] -translate-x-1/2 flex-col items-center gap-5 text-center">
        <h1
          className="text-[2.6rem] leading-tight"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          I&rsquo;ll also check in with you
        </h1>
        <p className="text-[16px]" style={{ color: tone.fgMuted }}>
          I&rsquo;ll add a quick check-in to your calendar to follow up tomorrow.
        </p>

        <div className="mt-6 flex w-[234px] flex-col items-center gap-3">
          <button
            type="button"
            onClick={handleConnect}
            disabled={connectDisabled}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97] disabled:opacity-60"
            style={{
              backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
              color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
            }}
          >
            {oauthInProgress ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Waiting for authorization…
              </>
            ) : (
              "Add to Google Calendar"
            )}
          </button>
          <button
            type="button"
            onClick={onSkip}
            disabled={oauthInProgress}
            className="text-body-small-default transition-opacity hover:opacity-100 disabled:opacity-60"
            style={{ color: tone.fgMuted }}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
