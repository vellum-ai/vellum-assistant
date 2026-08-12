import type { ReactNode } from "react";

import { Maximize2, Minimize2 } from "lucide-react";

import { Card, Skeleton } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import { SCHEDULE_USAGE_WINDOW_DAYS } from "@/utils/usage-window";

export interface ScheduleSummaryCardProps {
  title: string;
  subtitle: string;
  /** Icon shown beside the title in both collapsed and expanded states. */
  icon?: ReactNode;
  /** Pre-formatted cost string, e.g. "$4.29". */
  costLabel: string;
  costStatus: "loading" | "error" | "ready";
  isExpanded: boolean;
  onToggleExpand: () => void;
  /** Label shown in the hover overlay of the collapsed card. */
  expandLabel?: string;
  /** Rendered inside the card body only when expanded. */
  children?: ReactNode;
}

/** Icon + title + subtitle block, shared by the collapsed and expanded states
 *  so the header stays identical when the card expands. */
export function SummaryCardHeader({
  icon,
  title,
  subtitle,
}: {
  icon?: ReactNode;
  title: string;
  /** Omitted (or matching the title) renders no subtitle line. */
  subtitle?: string;
}) {
  const showSubtitle = Boolean(subtitle && subtitle.trim() !== title.trim());
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2.5">
        {icon ? (
          <span className="flex shrink-0 items-center">{icon}</span>
        ) : null}
        <span className="text-title-small text-[var(--content-emphasised)]">
          {title}
        </span>
      </div>
      {showSubtitle ? (
        <span className="text-body-medium-default text-[var(--content-tertiary)]">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

/** Top-right minimize/unexpand control, shared by the expanded card and the
 *  inline detail view. */
export function MinimizeButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <Minimize2 className="h-4 w-4" />
    </button>
  );
}

function CostDisplay({
  costLabel,
  costStatus,
}: {
  costLabel: string;
  costStatus: ScheduleSummaryCardProps["costStatus"];
}) {
  const { t } = useTranslation("schedules");

  if (costStatus === "loading") {
    return (
      <Skeleton
        as="span"
        aria-label={t("scheduleSummaryCard.costLoading")}
        className="h-7 w-44 rounded-md"
      />
    );
  }
  return (
    <div className="inline-flex w-fit items-baseline gap-1.5 rounded-md bg-[var(--surface-sunken)] px-2.5 py-1">
      <span className="text-title-small text-[var(--content-default)]">
        {costStatus === "error" ? "—" : costLabel}
      </span>
      <span className="text-body-small-default text-[var(--content-tertiary)]">
        {t("scheduleSummaryCard.costCaption", {
          days: SCHEDULE_USAGE_WINDOW_DAYS,
        })}
      </span>
    </div>
  );
}

export function ScheduleSummaryCard({
  title,
  subtitle,
  icon,
  costLabel,
  costStatus,
  isExpanded,
  onToggleExpand,
  expandLabel,
  children,
}: ScheduleSummaryCardProps) {
  const { t } = useTranslation("schedules");
  const resolvedExpandLabel = expandLabel ?? t("scheduleSummaryCard.expand");
  if (isExpanded) {
    return (
      <Card padding="lg">
        <div className="flex items-start justify-between gap-4">
          <SummaryCardHeader icon={icon} title={title} subtitle={subtitle} />
          <MinimizeButton
            label={t("scheduleSummaryCard.minimize", { title })}
            onClick={onToggleExpand}
          />
        </div>
        <div className="mt-4">{children}</div>
      </Card>
    );
  }

  return (
    <Card asChild noPadding>
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={false}
        aria-label={resolvedExpandLabel}
        className="group relative flex w-full cursor-pointer flex-col gap-3 overflow-hidden p-6 text-left transition-[transform,box-shadow] duration-200 ease-out will-change-transform hover:scale-[1.02] hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none motion-reduce:hover:scale-100"
      >
        <SummaryCardHeader icon={icon} title={title} subtitle={subtitle} />
        <CostDisplay costLabel={costLabel} costStatus={costStatus} />
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-[color-mix(in_srgb,var(--content-default)_10%,transparent)] opacity-0 backdrop-blur-[1px] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <span className="flex items-center gap-2 rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 py-1.5 text-[var(--content-default)] shadow-sm">
            <Maximize2 className="h-4 w-4" />
            <span className="text-label-medium-default">
              {resolvedExpandLabel}
            </span>
          </span>
        </span>
      </button>
    </Card>
  );
}
