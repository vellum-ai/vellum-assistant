/**
 * Shared top bar for onboarding steps: a back chevron pinned top-left, plus an
 * optional forward chevron. The forward chevron only renders when `onNext` is
 * provided — the flow wires it up only after the user has stepped back, so it
 * acts as a "redo" rather than always offering to skip ahead.
 *
 * SPIKE — research-onboarding flow.
 *
 * `tone` picks the foreground color: "dark" for colored backgrounds (the
 * avatar-tinted steps), "light" for dark backgrounds (the picker).
 */

import { ChevronLeft, ChevronRight } from "lucide-react";

import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

export function OnboardingTopBar({
  onBack,
  onNext,
  tone,
}: {
  onBack: () => void;
  /** When provided, renders the forward (redo) chevron. */
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
  const hoverBg = tone
    ? tone === "dark"
      ? "rgba(0,0,0,0.08)"
      : "rgba(255,255,255,0.12)"
    : auto.wash;

  return (
    <div className="absolute left-4 top-6 z-10 flex items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="flex cursor-pointer h-8 w-8 items-center justify-center rounded-md transition-colors duration-150"
        style={{ color: fg }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      {/* Forward (redo) chevron — only after the user has stepped back. */}
      {onNext ? (
        <button
          type="button"
          onClick={onNext}
          aria-label="Forward"
          className="flex cursor-pointer h-8 w-8 items-center justify-center rounded-md transition-colors duration-150"
          style={{ color: fg }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      ) : null}
    </div>
  );
}
