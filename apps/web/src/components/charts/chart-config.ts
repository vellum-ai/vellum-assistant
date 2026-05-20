import type { CSSProperties } from "react";

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "#1c2024",
  border: "1px solid #2d3339",
  borderRadius: 8,
  padding: "10px 14px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
};

export const CHART_TOOLTIP_LABEL_STYLE: CSSProperties = {
  color: "#a9b2bb",
  fontSize: 12,
  fontWeight: 500,
  marginBottom: 4,
};

export const CHART_TOOLTIP_ITEM_STYLE: CSSProperties = {
  color: "#f6f5f4",
  fontSize: 13,
  padding: "2px 0",
};

export const CHART_GRID_PROPS = {
  strokeDasharray: "3 3",
  stroke: "#3a3f47",
  strokeOpacity: 0.4,
  vertical: false,
} as const;

export const CHART_AXIS_TICK = { fontSize: 12, fill: "#8d99a5" } as const;

export const CHART_AXIS_LINE = {
  stroke: "#3a3f47",
  strokeOpacity: 0.4,
} as const;

export const BAR_CHART_PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
] as const;
