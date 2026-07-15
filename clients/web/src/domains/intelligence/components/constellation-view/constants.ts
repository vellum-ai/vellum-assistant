import {
  CATEGORY_NODE_SIZE,
  SUB_CATEGORY_NODE_SIZE,
} from "@/domains/intelligence/components/constellation-layout";

// ─── Zoom & viewport ────────────────────────────────────────────────────────

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.25;
export const VIRTUAL_CENTER = { x: 600, y: 450 } as const;

// ─── Animation ──────────────────────────────────────────────────────────────

/** Shared spring transition for node entry animations. */
export const NODE_SPRING = { type: "spring" as const, stiffness: 180, damping: 20 };

// ─── Node shell variants ────────────────────────────────────────────────────

export type NodeShellVariant = "category" | "subcategory";

interface VariantConfig {
  size: number;
  cornerRadius: number;
  dashed: boolean;
  fillPct: number;
  fillHoverPct: number;
  strokePct: number;
  strokeHoverPct: number;
  strokeWidth: number;
  strokeHoverWidth: number;
}

export const NODE_VARIANT_CONFIGS: Record<NodeShellVariant, VariantConfig> = {
  category: {
    size: CATEGORY_NODE_SIZE,
    cornerRadius: 14,
    dashed: false,
    fillPct: 14,
    fillHoverPct: 25,
    strokePct: 55,
    strokeHoverPct: 85,
    strokeWidth: 2,
    strokeHoverWidth: 2.5,
  },
  subcategory: {
    size: SUB_CATEGORY_NODE_SIZE,
    cornerRadius: 10,
    dashed: true,
    fillPct: 10,
    fillHoverPct: 20,
    strokePct: 40,
    strokeHoverPct: 70,
    strokeWidth: 1.5,
    strokeHoverWidth: 2,
  },
};

// ─── Legend ──────────────────────────────────────────────────────────────────

export type LegendShape = "category" | "subcategory" | "skill" | "workspace";

export const LEGEND_SHAPE_CLASSES: Record<LegendShape, string> = {
  category: "rounded-[3px]",
  subcategory: "rounded-[3px] border-dashed",
  skill: "rotate-45",
  workspace: "rounded-full",
};
