import { ArrowRight, Check } from "lucide-react";

/** One dimension of the change: what it was, what it becomes, and whether it has landed. */
export interface UpgradeMetric {
  label: string;
  /** Null when the from-side is unknown, e.g. a freshly hatched assistant. */
  from: string | null;
  to: string;
  landed?: boolean;
}

export interface UpgradeMetricsProps {
  items: UpgradeMetric[];
  /** Fades and lifts the row in; out, it keeps its space so nothing shifts. */
  visible?: boolean;
  className?: string;
}

/**
 * The resource chips of the provisioning takeover, set as a line of type
 * instead of a row of boxes: a small label over the move in the serif, the
 * columns parted by hairlines. The row is what the upgrade shows now and
 * then beneath its status, so it fades rather than snaps.
 */
export function UpgradeMetrics({
  items,
  visible = true,
  className = "",
}: UpgradeMetricsProps) {
  return (
    <div
      aria-hidden={!visible}
      data-testid="upgrade-metrics"
      data-visible={visible ? "true" : "false"}
      className={`flex items-stretch justify-center transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      } ${className}`}
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`flex flex-col items-center gap-1.5 px-8 ${
            index > 0 ? "border-l border-[var(--border-subtle)]" : ""
          }`}
        >
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--content-tertiary)]">
            {item.label}
          </span>
          <span
            className="flex items-center gap-2 whitespace-nowrap text-[var(--content-emphasised)]"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "24px",
              lineHeight: 1.2,
            }}
          >
            {item.from != null && (
              <>
                <span className="text-[var(--content-tertiary)]">
                  {item.from}
                </span>
                <ArrowRight
                  className="size-4 text-[var(--content-tertiary)]"
                  aria-hidden="true"
                />
              </>
            )}
            <span>{item.to}</span>
            {item.landed && (
              <Check
                className="size-4 text-[var(--system-positive-strong)]"
                aria-hidden="true"
              />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
