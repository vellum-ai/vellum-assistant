/** The recency window the graph highlights. "all" disables the lens. */
export type RecencyWindow = "all" | "month" | "week";

interface RecencyLensProps {
  value: RecencyWindow;
  onChange: (value: RecencyWindow) => void;
}

const SEGMENTS: { value: RecencyWindow; label: string }[] = [
  { value: "all", label: "All" },
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
];

/**
 * Segmented "All · Month · Week" control that picks the recency window the graph
 * emphasizes: concepts updated outside the window ghost out (like non-matches of
 * the search lens), so "what did it learn recently?" pops. Styled to match the
 * search pill; marked `data-graph-control` so clicks don't start an orbit drag.
 */
export function RecencyLens({ value, onChange }: RecencyLensProps) {
  return (
    <div
      data-graph-control
      role="group"
      aria-label="Recency window"
      className="flex items-center gap-0.5 rounded-full p-0.5 text-[12px]"
      style={{
        backgroundColor: "color-mix(in srgb, var(--surface-base) 82%, transparent)",
        border: "1px solid var(--border-base)",
      }}
    >
      {SEGMENTS.map((seg) => {
        const active = seg.value === value;
        return (
          <button
            key={seg.value}
            type="button"
            onClick={() => onChange(seg.value)}
            aria-pressed={active}
            className="rounded-full px-2 py-0.5 transition-colors"
            style={
              active
                ? {
                    color: "var(--content-default)",
                    backgroundColor:
                      "color-mix(in srgb, var(--content-default) 10%, transparent)",
                  }
                : { color: "var(--content-tertiary)" }
            }
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
