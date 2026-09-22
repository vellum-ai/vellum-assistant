import { ArrowRight, Check } from "lucide-react";
import { useEffect, useState } from "react";

/** One dimension of the change: what it was, what it becomes, and whether it has landed. */
export interface UpgradeMetric {
  /** Names the column for tests, as `chip-<key>`. */
  key?: string;
  label: string;
  /** Null when the from-side is unknown, e.g. a freshly hatched assistant. */
  from: string | null;
  to: string;
  landed?: boolean;
  /**
   * The column's progress, spoken: the check is paint only, so without this
   * a landed dimension sounds identical to a pending one.
   */
  status?: string | null;
}

export interface UpgradeMetricsProps {
  items: UpgradeMetric[];
  /**
   * Brings the columns in, left to right, a beat apart; out, they leave
   * together and keep their space so nothing around them shifts.
   */
  visible?: boolean;
  /** The relation the arrow draws, spoken between the two sides. */
  toWord?: string;
  className?: string;
  testId?: string;
}

/** The beat between one column's entrance and the next. */
const STAGGER_MS = 220;

/**
 * The resource chips of the provisioning takeover, set as a line of type
 * instead of a row of boxes: a small label over the move in the serif, the
 * columns parted by hairlines, or stacked without them where a row would
 * not fit. The row arrives once the upgrade is under way and stays for the
 * rest of it, so it comes in column by column rather than all at once,
 * from its first frame on screen.
 */
export function UpgradeMetrics({
  items,
  visible = true,
  toWord,
  className = "",
  testId = "upgrade-metrics",
}: UpgradeMetricsProps) {
  // The entrance needs a frame at the hidden end to transition from.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const shown = visible && entered;

  return (
    <div
      aria-hidden={!visible}
      data-testid={testId}
      data-visible={visible ? "true" : "false"}
      className={`flex flex-col items-center gap-3 md:flex-row md:items-stretch md:gap-0 ${className}`}
    >
      {items.map((item, index) => (
        <div
          key={item.key ?? item.label}
          data-testid={item.key ? `chip-${item.key}` : undefined}
          className={`flex flex-col items-center gap-1 px-6 transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none ${
            shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
          } ${index > 0 ? "md:border-l md:border-[var(--border-subtle)]" : ""}`}
          style={{ transitionDelay: shown ? `${index * STAGGER_MS}ms` : "0ms" }}
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
                {toWord && <span className="sr-only">{toWord}</span>}
                <ArrowRight
                  className="size-3.5 text-[var(--content-tertiary)]"
                  aria-hidden="true"
                />
              </>
            )}
            <span>{item.to}</span>
            {item.landed && (
              <Check
                data-testid="chip-check"
                className="size-3.5 text-[var(--system-positive-strong)]"
                aria-hidden="true"
              />
            )}
            {item.status && <span className="sr-only">{item.status}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
