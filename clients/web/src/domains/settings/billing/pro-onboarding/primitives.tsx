import type { LucideIcon } from "lucide-react";

export function StepDots({ current, total = 2 }: { current: number; total?: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className="h-1.5 rounded-full transition-all duration-300"
          style={{
            width: i === current ? 20 : 6,
            backgroundColor:
              i <= current
                ? "var(--content-default)"
                : "var(--border-element)",
          }}
        />
      ))}
    </div>
  );
}

export function IconBadge({
  icon: Icon,
  tone = "positive",
}: {
  icon: LucideIcon;
  tone?: "positive" | "negative" | "warning";
}) {
  const toneVar =
    tone === "positive"
      ? "--system-positive-strong"
      : tone === "warning"
        ? "--system-mid-strong"
        : "--system-negative-strong";
  return (
    <span
      className="flex h-11 w-11 items-center justify-center rounded-full"
      style={{
        backgroundColor: `color-mix(in oklab, var(${toneVar}) 12%, transparent)`,
      }}
    >
      <Icon
        className="h-5 w-5"
        style={{ color: `var(${toneVar})` }}
        aria-hidden="true"
      />
    </span>
  );
}
