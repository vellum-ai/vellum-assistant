/**
 * Shared top bar for onboarding steps: a back chevron, centered progress bars
 * + label, and an invisible spacer on the right so the progress stays truly
 * centered (the chevron on the left is balanced by the spacer).
 *
 * SPIKE — research-onboarding flow.
 *
 * `tone` picks the foreground color: "dark" for colored backgrounds (the
 * avatar-tinted steps), "light" for dark backgrounds (the picker).
 */

import { ChevronLeft, ChevronRight } from "lucide-react";

import { StepIndicatorDots } from "@/domains/onboarding/components/step-indicator-dots";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

export function OnboardingTopBar({
  current,
  total,
  label,
  onBack,
  onNext,
  nextDisabled = false,
  tone,
}: {
  current: number;
  total: number;
  label: string;
  onBack: () => void;
  /** When provided, renders a forward chevron mirroring Continue. */
  onNext?: () => void;
  /** Disables the forward chevron (mirrors Continue's disabled state). */
  nextDisabled?: boolean;
  /**
   * Force the foreground tone. Omit on the avatar-tinted steps to auto-derive
   * from the chosen color (white on dark colors, black on yellow); pass
   * "light" on the dark-surface steps (picker) so they stay white.
   */
  tone?: "dark" | "light";
}) {
  const auto = useOnboardingTone();
  const fg = tone ? (tone === "dark" ? "#1A1A1A" : "#FFFFFF") : auto.fg;
  const labelColor = tone
    ? tone === "dark"
      ? "rgba(0,0,0,0.55)"
      : "rgba(255,255,255,0.7)"
    : auto.fgMuted;
  const hoverBg = tone
    ? tone === "dark"
      ? "rgba(0,0,0,0.08)"
      : "rgba(255,255,255,0.12)"
    : auto.wash;

  return (
    <div className="absolute left-1/2 top-6 z-10 flex -translate-x-1/2 items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-150"
        style={{ color: fg }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="flex flex-col items-center gap-2">
        <StepIndicatorDots current={current} total={total} color={fg} />
        <span
          className="text-body-small-default"
          style={{ color: labelColor }}
        >
          {label}
        </span>
      </div>
      {/* Forward chevron (mirrors Continue), or an invisible spacer so the
          progress stays centered when there's no next action. */}
      {onNext ? (
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          aria-label="Continue"
          className="flex h-8 w-8 items-center justify-center rounded-md transition-[color,background-color,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-30"
          style={{ color: fg }}
          onMouseEnter={(e) => {
            if (!nextDisabled) e.currentTarget.style.backgroundColor = hoverBg;
          }}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      ) : (
        <div aria-hidden="true" className="h-8 w-8" />
      )}
    </div>
  );
}
