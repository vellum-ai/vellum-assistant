import { CHART_TOOLTIP_STYLE } from "@/components/charts/chart-config";
import { formatDateLabel } from "@/components/charts/format-date-label";

export type TooltipRowItem = {
  key: string;
  color: string;
  label: string;
  value: string;
  numericValue: number;
};

export function TooltipRow({ item }: { item: TooltipRowItem }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "2px 0",
        fontSize: 13,
        color: "#f6f5f4",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: item.color,
          flexShrink: 0,
        }}
      />
      <span>{item.label}</span>
      <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
        {item.value}
      </span>
    </div>
  );
}

export type TooltipPayloadEntry = {
  dataKey: string;
  value: number;
  payload?: { __hoveredKey?: string };
};

interface StackedBarTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  labelMap: Record<string, string>;
  colorMap: Record<string, string>;
  formatValue: (v: number) => string;
  showTotal?: boolean;
  formatLabel?: (label: string) => string;
}

export function StackedBarTooltip({
  active,
  payload,
  label,
  labelMap,
  colorMap,
  formatValue,
  showTotal,
  formatLabel,
}: StackedBarTooltipProps) {
  if (!active || !payload?.length) return null;

  const hoveredKey = payload.find((p) => p.payload?.__hoveredKey)?.payload
    ?.__hoveredKey as string | undefined;

  const items: TooltipRowItem[] = payload
    .filter((p) => p.value != null && p.dataKey != null)
    .map((p) => ({
      key: String(p.dataKey),
      label: labelMap[String(p.dataKey)] ?? String(p.dataKey),
      value: formatValue(Number(p.value)),
      color: colorMap[String(p.dataKey)] ?? "#6b7280",
      numericValue: Number(p.value),
    }))
    .sort((a, b) => {
      if (a.numericValue !== b.numericValue) {
        return b.numericValue - a.numericValue;
      }
      return a.label.localeCompare(b.label);
    });

  const hovered = hoveredKey
    ? items.find((i) => i.key === hoveredKey)
    : null;
  const rest = hovered ? items.filter((i) => i.key !== hoveredKey) : items;

  const total = items.reduce((sum, i) => sum + i.numericValue, 0);

  return (
    <div style={CHART_TOOLTIP_STYLE}>
      <div
        style={{
          color: "#a9b2bb",
          fontSize: 12,
          fontWeight: 500,
          marginBottom: 6,
        }}
      >
        {(formatLabel ?? formatDateLabel)(String(label))}
      </div>
      {hovered && (
        <>
          <TooltipRow item={hovered} />
          {rest.length > 0 && (
            <div
              style={{ borderTop: "1px solid #3a3f47", margin: "6px 0" }}
            />
          )}
        </>
      )}
      {rest.map((item) => (
        <TooltipRow key={item.key} item={item} />
      ))}
      {showTotal && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "2px 0",
            fontSize: 13,
            color: "#f6f5f4",
            fontWeight: 600,
            borderTop: "1px solid rgba(255,255,255,0.15)",
            paddingTop: 6,
            marginTop: 4,
          }}
        >
          <span>Total: {formatValue(total)}</span>
        </div>
      )}
    </div>
  );
}
