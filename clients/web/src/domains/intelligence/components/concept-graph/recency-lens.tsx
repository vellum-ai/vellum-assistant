import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellumai/design-library";

/** The recency window the graph highlights. "all" disables the lens. */
export type RecencyWindow = "all" | "month" | "week";

interface RecencyLensProps {
  value: RecencyWindow;
  onChange: (value: RecencyWindow) => void;
}

const ITEMS: SegmentControlItem<RecencyWindow>[] = [
  { value: "all", label: "All" },
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
];

/**
 * Segmented "All · Month · Week" control that picks the recency window the graph
 * emphasizes: concepts updated outside the window ghost out (like non-matches of
 * the search lens), so "what did it learn recently?" pops. The caller's
 * positioning wrapper carries `data-graph-control` so clicks don't start an
 * orbit drag.
 */
export function RecencyLens({ value, onChange }: RecencyLensProps) {
  return (
    <SegmentControl<RecencyWindow>
      ariaLabel="Recency window"
      items={ITEMS}
      value={value}
      onChange={onChange}
      // Labeled mode defaults to full width with flex-1 segments; keep it
      // compact (sized to its content) for the floating graph overlay.
      className="!w-auto [&>*]:!flex-none"
    />
  );
}
