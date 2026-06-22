interface StepIndicatorDotsProps {
  current: number;
  total: number;
  /** Bar color. Defaults to the theme's content color. */
  color?: string;
}

/**
 * Progress indicator bars for the iOS onboarding flow. Renders `total`
 * horizontal bars where steps up to and including `current` are filled
 * (solid) and remaining steps are faded.
 */
export function StepIndicatorDots({
  current,
  total,
  color,
}: StepIndicatorDotsProps) {
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
          className="h-[3px] w-8 rounded-full transition-colors"
          style={
            color
              ? { backgroundColor: color, opacity: i <= current ? 1 : 0.3 }
              : undefined
          }
        >
          {color ? null : (
            <div
              className={`h-full w-full rounded-full bg-[var(--content-default)] ${
                i <= current ? "" : "opacity-20"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
