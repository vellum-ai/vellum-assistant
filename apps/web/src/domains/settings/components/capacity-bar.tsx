export interface CapacityBarProps {
  value: number;
  max: number;
  caption?: string;
}

export function CapacityBar({ value, max, caption }: CapacityBarProps) {
  const percent =
    max > 0 ? Math.max(0, Math.min((value / max) * 100, 100)) : 0;
  const isCritical = percent > 90;

  return (
    <div className="flex flex-col gap-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-active)]">
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{
            width: `${percent}%`,
            backgroundColor: isCritical
              ? "var(--system-negative-strong)"
              : "var(--system-positive-strong)",
          }}
        />
      </div>
      {caption && (
        <span className="text-label-medium-default text-[var(--content-tertiary)]">
          {caption}
        </span>
      )}
    </div>
  );
}
