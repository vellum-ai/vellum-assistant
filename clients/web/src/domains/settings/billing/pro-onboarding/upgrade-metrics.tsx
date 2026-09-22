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
  /**
   * Brings the columns in, left to right, a beat apart; out, they leave
   * together and keep their space so nothing around them shifts.
   */
  visible?: boolean;
  className?: string;
}

/** The beat between one column's entrance and the next. */
const STAGGER_MS = 220;

/**
 * The resource chips of the provisioning takeover, set as a line of type
 * instead of a row of boxes: a small label over the move in the serif, the
 * columns parted by hairlines. The row arrives once the upgrade is under
 * way and stays for the rest of it, so it comes in column by column rather
 * than all at once.
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
      className={`flex items-stretch justify-center ${className}`}
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`flex flex-col items-center gap-1 px-6 transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none ${
            visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
          } ${index > 0 ? "border-l border-[var(--border-subtle)]" : ""}`}
          style={{
            transitionDelay: visible ? `${index * STAGGER_MS}ms` : "0ms",
          }}
        >
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--content-tertiary)]">
            {item.label}
          </span>
          <span
            className="flex items-center gap-1.5 whitespace-nowrap text-[var(--content-emphasised)]"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "20px",
              lineHeight: 1.2,
            }}
          >
            {item.from != null && (
              <>
                <span className="text-[var(--content-tertiary)]">
                  {item.from}
                </span>
                <ArrowRight
                  className="size-3.5 text-[var(--content-tertiary)]"
                  aria-hidden="true"
                />
              </>
            )}
            <span>{item.to}</span>
            {item.landed && (
              <Check
                className="size-3.5 text-[var(--system-positive-strong)]"
                aria-hidden="true"
              />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
