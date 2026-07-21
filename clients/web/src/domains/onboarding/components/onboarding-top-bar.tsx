/**
 * Shared top bar for onboarding steps: a back arrow pinned top-left, plus an
 * optional forward arrow. The forward arrow only renders when `onNext` is
 * provided — the flow wires it up only after the user has stepped back, so it
 * acts as a "redo" rather than always offering to skip ahead.
 *
 * SPIKE — research-onboarding flow.
 *
 * `tone` picks the foreground color: "dark" for colored backgrounds (the
 * avatar-tinted steps), "light" for dark backgrounds (the picker).
 */

import { ArrowLeft, ArrowRight } from "lucide-react";

import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

export function OnboardingTopBar({
  onBack,
  onNext,
  tone,
}: {
  onBack: () => void;
  /** When provided, renders the forward (redo) arrow. */
  onNext?: () => void;
  /**
   * Force the foreground tone. Omit on the avatar-tinted steps to auto-derive
   * from the chosen color (white on dark colors, black on yellow); pass
   * "light" on the dark-surface steps (picker) so they stay white.
   */
  tone?: "dark" | "light";
}) {
  const auto = useOnboardingTone();
  const fg = tone ? (tone === "dark" ? "#1A1A1A" : "#FFFFFF") : auto.fg;
  // Matches the avatar-picker's cycle arrows: a circular button tinted by its
  // own foreground color, darkening further on hover.
  const restBg = `color-mix(in srgb, ${fg} 10%, transparent)`;
  const hoverBg = `color-mix(in srgb, ${fg} 18%, transparent)`;

  return (
    <div className="absolute left-4 top-6 z-10 flex items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="flex cursor-pointer h-10 w-10 items-center justify-center rounded-full transition-colors duration-150"
        style={{ color: fg, backgroundColor: restBg }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = restBg)}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      {/* Forward (redo) arrow — only after the user has stepped back. */}
      {onNext ? (
        <button
          type="button"
          onClick={onNext}
          aria-label="Forward"
          className="flex cursor-pointer h-10 w-10 items-center justify-center rounded-full transition-colors duration-150"
          style={{ color: fg, backgroundColor: restBg }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = restBg)}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
