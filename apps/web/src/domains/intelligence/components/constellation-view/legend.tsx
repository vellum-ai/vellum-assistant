
import { cn } from "@/utils/misc";

import { LEGEND_SHAPE_CLASSES, type LegendShape } from "@/domains/intelligence/components/constellation-view/constants";

function LegendRow({ shape, label }: { shape: LegendShape; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-4 w-4 items-center justify-center">
        <span
          className={cn(
            "inline-block h-3 w-3 border-[1.5px] border-[var(--content-tertiary)]",
            LEGEND_SHAPE_CLASSES[shape],
          )}
        />
      </span>
      <span>{label}</span>
    </div>
  );
}

export interface LegendProps {
  visible: boolean;
}

export function Legend({ visible }: LegendProps) {
  return (
    <div
      data-constellation-control
      className="pointer-events-none absolute bottom-4 left-4 rounded-md px-3 py-2 text-body-small-default"
      style={{
        backgroundColor: "color-mix(in srgb, var(--surface-overlay) 80%, transparent)",
        border: "1px solid color-mix(in srgb, var(--content-tertiary) 20%, transparent)",
        color: "var(--content-secondary)",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.35s ease",
      }}
    >
      <div className="space-y-1.5">
        <LegendRow shape="category" label="Category" />
        <LegendRow shape="subcategory" label="Subcategory" />
        <LegendRow shape="skill" label="Skill" />
        <LegendRow shape="workspace" label="Workspace" />
      </div>
    </div>
  );
}
