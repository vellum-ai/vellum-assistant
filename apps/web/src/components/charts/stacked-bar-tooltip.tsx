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
    <div className="flex items-center gap-2 py-0.5 text-[13px] text-[var(--content-default)]">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: item.color }}
      />
      <span>{item.label}</span>
      <span className="ml-auto tabular-nums">{item.value}</span>
    </div>
  );
}

export type TooltipPayloadEntry = {
  dataKey: string;
  value: number;
};

interface StackedBarTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  hoveredKey?: string;
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
  hoveredKey,
  label,
  labelMap,
  colorMap,
  formatValue,
  showTotal,
  formatLabel,
}: StackedBarTooltipProps) {
  if (!active || !payload?.length) return null;

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
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-overlay)] px-3.5 py-2.5 shadow-[var(--shadow-popover)]">
      <div className="mb-1.5 text-xs font-medium text-[var(--content-secondary)]">
        {(formatLabel ?? formatDateLabel)(String(label))}
      </div>
      {hovered && (
        <>
          <TooltipRow item={hovered} />
          {rest.length > 0 && (
            <div className="my-1.5 border-t border-[var(--border-subtle)]" />
          )}
        </>
      )}
      {rest.map((item) => (
        <TooltipRow key={item.key} item={item} />
      ))}
      {showTotal && (
        <div className="mt-1 flex items-center gap-2 border-t border-[var(--border-subtle)] pt-1.5 text-[13px] font-semibold text-[var(--content-default)]">
          <span>Total: {formatValue(total)}</span>
        </div>
      )}
    </div>
  );
}
