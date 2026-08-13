import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

/** The recency window the graph highlights. "all" disables the lens. */
export type RecencyWindow = "all" | "month" | "week";

interface RecencyLensProps {
  value: RecencyWindow;
  onChange: (value: RecencyWindow) => void;
}

/**
 * Segmented "All · Month · Week" control that picks the recency window the graph
 * emphasizes: concepts updated outside the window ghost out (like non-matches of
 * the search lens), so "what did it learn recently?" pops. The caller's
 * positioning wrapper carries `data-graph-control` so clicks don't start an
 * orbit drag.
 */
export function RecencyLens({ value, onChange }: RecencyLensProps) {
  const { t } = useTranslation("intelligence");
  const items: SegmentControlItem<RecencyWindow>[] = [
    { value: "all", label: t("recencyLens.all") },
    { value: "month", label: t("recencyLens.month") },
    { value: "week", label: t("recencyLens.week") },
  ];
  return (
    <SegmentControl<RecencyWindow>
      ariaLabel={t("recencyLens.ariaLabel")}
      items={items}
      value={value}
      onChange={onChange}
      // Labeled mode defaults to full width with flex-1 segments; keep it
      // compact (sized to its content) for the floating graph overlay.
      className="!w-auto [&>*]:!flex-none"
    />
  );
}
