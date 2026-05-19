
/**
 * Horizontal capacity/utilization bar used for disk/CPU/memory in the General
 * settings card. Mirrors the macOS capacity bar: fills with the brand success
 * color by default and turns red (error) once usage exceeds 90%.
 */
export interface CapacityBarProps {
  /** Current value; may be anything as long as `max` has the same unit. */
  value: number;
  /** Maximum value; when <= 0 the bar renders empty. */
  max: number;
  /** Optional caption rendered below the bar (e.g. "320 MB used of 1024 MB"). */
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
        <span className="text-label-medium-default text-[var(--content-tertiary)]">{caption}</span>
      )}
    </div>
  );
}
