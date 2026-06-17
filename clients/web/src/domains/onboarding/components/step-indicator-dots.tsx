interface StepIndicatorDotsProps {
  current: number;
  total: number;
}

/**
 * Progress indicator bars for the iOS onboarding flow. Renders `total`
 * horizontal bars where steps up to and including `current` are filled
 * (dark) and remaining steps are unfilled (light).
 */
export function StepIndicatorDots({ current, total }: StepIndicatorDotsProps) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={`Step ${current + 1} of ${total}`}
    >
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={`h-[3px] w-8 rounded-full transition-colors ${
            i <= current
              ? "bg-[var(--content-default)]"
              : "bg-[var(--content-default)] opacity-20"
          }`}
        />
      ))}
    </div>
  );
}
