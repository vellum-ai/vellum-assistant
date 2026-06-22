/**
 * "Let's chat tomorrow" step content — invite the user to add a Day-2 check-in
 * to their calendar, now part of the onboarding flow itself.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only (the toned backdrop sits behind, so the assistant color, its
 * eyes, and the tone characters carry over). The actual Google Calendar OAuth
 * isn't wired here yet (it needs the hatched assistant) — both actions just
 * advance the flow for now.
 */

import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

interface LetsChatTomorrowStepProps {
  onConnect: () => void;
  onSkip: () => void;
  onBack: () => void;
}

export function LetsChatTomorrowStep({
  onConnect,
  onSkip,
  onBack,
}: LetsChatTomorrowStepProps) {
  const tone = useOnboardingTone();
  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar
        current={4}
        total={5}
        label="Quick setup"
        onBack={onBack}
        onNext={onConnect}
      />

      <div className="absolute left-1/2 top-[26%] flex w-[360px] -translate-x-1/2 flex-col items-center gap-5 text-center">
        <h1
          className="text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Let&rsquo;s chat tomorrow
        </h1>
        <p className="text-[16px]" style={{ color: tone.fgMuted }}>
          Add a meeting in your calendar so we can pick up where we left off.
        </p>

        <div className="mt-6 flex w-[234px] flex-col items-center gap-3">
          <button
            type="button"
            onClick={onConnect}
            className="flex h-11 w-full items-center justify-center rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97]"
            style={{
              backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
              color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
            }}
          >
            Connect Google Calendar
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="text-body-small-default transition-opacity hover:opacity-100"
            style={{ color: tone.fgMuted }}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
