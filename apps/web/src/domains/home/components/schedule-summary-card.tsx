import type { ReactNode } from "react";

import { Maximize2, Minimize2 } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { Card } from "@vellumai/design-library";

export interface ScheduleSummaryCardProps {
  title: string;
  subtitle: string;
  /** Pre-formatted cost string, e.g. "$4.29". */
  costLabel: string;
  costStatus: "loading" | "error" | "ready";
  isExpanded: boolean;
  onToggleExpand: () => void;
  /** Rendered inside the card body only when expanded. */
  children?: ReactNode;
}

function CostDisplay({
  costLabel,
  costStatus,
}: {
  costLabel: string;
  costStatus: ScheduleSummaryCardProps["costStatus"];
}) {
  return (
    <div className="flex shrink-0 flex-col items-end text-right">
      <span className="mb-0.5 text-label-small-default text-[var(--content-tertiary)]">
        Cost (7d)
      </span>
      {costStatus === "loading" ? (
        <span
          aria-label="Loading cost"
          className="h-5 w-16 animate-pulse rounded bg-[var(--surface-muted)]"
        />
      ) : (
        <span className="text-body-medium-default text-[var(--content-default)]">
          {costStatus === "error" ? "—" : costLabel}
        </span>
      )}
    </div>
  );
}

export function ScheduleSummaryCard({
  title,
  subtitle,
  costLabel,
  costStatus,
  isExpanded,
  onToggleExpand,
  children,
}: ScheduleSummaryCardProps) {
  if (isExpanded) {
    return (
      <DetailCard
        title={title}
        subtitle={subtitle}
        compactAccessory
        accessory={
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={`Minimize ${title}`}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
        }
      >
        {children}
      </DetailCard>
    );
  }

  return (
    <Card asChild>
      <button
        type="button"
        onClick={onToggleExpand}
        className="group relative flex w-full cursor-pointer items-start justify-between gap-4 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-title-medium text-[var(--content-emphasised)]">
            {title}
          </span>
          <span className="text-body-medium-default text-[var(--content-tertiary)]">
            {subtitle}
          </span>
        </div>
        <CostDisplay costLabel={costLabel} costStatus={costStatus} />
        <span
          aria-label={`Expand ${title}`}
          className="absolute right-2 top-2 text-[var(--content-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <Maximize2 className="h-4 w-4" />
        </span>
      </button>
    </Card>
  );
}
