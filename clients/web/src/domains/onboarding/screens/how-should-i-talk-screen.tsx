/**
 * "How should I talk?" step content — pick a conversational style.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground content only; the background color, the assistant's eyes, and the
 * peeking tone characters live in the persistent `OnboardingTonedBackdrop` so
 * they carry across the later steps. Selecting an option (controlled by the
 * route) enables Continue and pops the tone character(s) in via the backdrop.
 */

import { ArrowRight } from "lucide-react";

import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import type { TalkStyle } from "@/domains/onboarding/components/onboarding-toned-backdrop";

interface HowShouldITalkScreenProps {
  selected: TalkStyle | null;
  onSelect: (style: TalkStyle) => void;
  onContinue: () => void;
  onSkip: () => void;
  onBack: () => void;
}

const OPTIONS: { id: TalkStyle; label: string }[] = [
  { id: "simple", label: "Simple and short" },
  { id: "details", label: "Go into details" },
];

export function HowShouldITalkScreen({
  selected,
  onSelect,
  onContinue,
  onSkip,
  onBack,
}: HowShouldITalkScreenProps) {
  const tone = useOnboardingTone();
  const pillClass =
    "w-[180px] rounded-2xl px-4 py-6 text-center text-[16px] font-medium " +
    "transition-colors duration-150 cursor-pointer";

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar
        current={4}
        total={5}
        label="Quick setup"
        onBack={onBack}
        onNext={onContinue}
        nextDisabled={!selected}
      />

      {/* Title + options + actions */}
      <div className="absolute left-1/2 top-[28%] flex -translate-x-1/2 flex-col items-center gap-16">
        <h1
          className="text-center text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          How should I talk?
        </h1>

        <div className="flex items-stretch gap-4">
          {OPTIONS.map((opt) => {
            const active = selected === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onSelect(opt.id)}
                aria-pressed={active}
                className={pillClass}
                style={{
                  backgroundColor: tone.isLight
                    ? active
                      ? "rgba(0,0,0,0.16)"
                      : "rgba(0,0,0,0.07)"
                    : active
                      ? "rgba(255,255,255,0.28)"
                      : "rgba(255,255,255,0.1)",
                  boxShadow: active
                    ? `inset 0 0 0 1.5px ${tone.isLight ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.6)"}`
                    : "none",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col items-center gap-4">
          <button
            type="button"
            disabled={!selected}
            onClick={onContinue}
            className="flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] bg-black text-body-medium-default text-white transition-[opacity,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="text-body-small-default transition-opacity hover:opacity-100"
            style={{ color: tone.fgMuted }}
          >
            Skip this step
          </button>
        </div>
      </div>
    </div>
  );
}
