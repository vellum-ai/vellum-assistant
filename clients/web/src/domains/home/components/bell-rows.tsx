import {
  ActivityIcon,
  Check,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Loader2,
  PauseCircle,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { useTranslation } from "@/i18n";
import type { FeedItem, FeedItemRunState } from "@vellumai/assistant-api";
import { Button, cn, Typography } from "@vellumai/design-library";

import { formatRunElapsed, isRunInFlight, isRunQuiet } from "../notification-buckets";
import { resolveFeedItemTitle } from "../utils";

/**
 * The rows the bell draws for the feed's non-notification kinds: a live run, a
 * system-health counter, and the activity digest.
 *
 * They share one shell with `HomeRecapRow`'s compact card so the three
 * sections read as one list rather than as three widgets stacked up. What
 * differs is what occupies the trailing cell: a notification shows when it
 * arrived, a run shows how long it has been going, a health row shows how many
 * times it has failed.
 */

const CARD_CLASS = cn(
  "group relative flex w-full items-start gap-[var(--app-spacing-sm)]",
  "rounded-[var(--radius-lg)] border border-[var(--border-base)]",
  "bg-[var(--surface-overlay)] p-[var(--app-spacing-sm)]",
  "text-left transition-colors duration-150 hover:bg-[var(--surface-hover)]",
);

interface BellRowShellProps {
  icon: ReactNode;
  title: string;
  /** Second line. Omitted rows draw a single-line card. */
  detail?: string | null;
  /** Right-hand cell on the title line: elapsed time, a count, a timestamp. */
  trailing?: ReactNode;
  /** Buttons under the detail line. */
  footer?: ReactNode;
  onSelect?: () => void;
  ariaLabel?: string;
}

function BellRowShell({
  icon,
  title,
  detail,
  trailing,
  footer,
  onSelect,
  ariaLabel,
}: BellRowShellProps) {
  const body = (
    <>
      {/* The icon gutter is the same width as HomeRecapRow's unread-dot
          gutter, so titles line up down the whole list whatever kind of row
          they belong to. h-8 matches the first line's height there. */}
      <span className="pointer-events-none relative flex h-8 w-4 shrink-0 items-center justify-center">
        {icon}
      </span>

      <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-[var(--app-spacing-xxs)]">
        <span className="flex items-center gap-[var(--app-spacing-sm)]">
          <Typography
            variant="body-medium-default"
            className="min-w-0 flex-1 truncate leading-snug text-[var(--content-default)]"
          >
            {title}
          </Typography>
          {trailing !== undefined ? (
            <span className="ml-auto shrink-0">{trailing}</span>
          ) : null}
        </span>

        {detail ? (
          <Typography
            variant="body-medium-lighter"
            className="line-clamp-1 leading-normal text-[var(--content-secondary)]"
          >
            {detail}
          </Typography>
        ) : null}

        {footer ? (
          // Interactive again: the shell above is `pointer-events-none` so the
          // card's own click target underneath keeps receiving clicks.
          <span className="pointer-events-auto mt-[var(--app-spacing-xxs)] flex flex-wrap items-center gap-[var(--app-spacing-xs)]">
            {footer}
          </span>
        ) : null}
      </span>
    </>
  );

  if (!onSelect) {
    return <div className={CARD_CLASS}>{body}</div>;
  }

  return (
    <div className={CARD_CLASS}>
      {/* Stretched link, the same arrangement HomeRecapRow uses: one click
          target covering the card, with everything else stacked above it. */}
      <button
        type="button"
        aria-label={ariaLabel ?? title}
        onClick={onSelect}
        className="absolute inset-0 w-full cursor-pointer rounded-[var(--radius-lg)]"
      />
      {body}
    </div>
  );
}

/** Icon and tint per run state. */
const RUN_STATE_ICON: Record<
  FeedItemRunState,
  { Icon: ComponentType<{ className?: string }>; className: string; spin?: boolean }
> = {
  queued: { Icon: PauseCircle, className: "text-[var(--content-tertiary)]" },
  running: {
    Icon: Loader2,
    className: "text-[var(--content-secondary)]",
    spin: true,
  },
  needs_input: {
    Icon: CircleAlert,
    className: "text-[var(--system-mid-strong)]",
  },
  succeeded: { Icon: Check, className: "text-[var(--system-positive-strong)]" },
  failed: {
    Icon: TriangleAlert,
    className: "text-[var(--system-negative-strong)]",
  },
  cancelled: { Icon: CircleSlash, className: "text-[var(--content-tertiary)]" },
  interrupted: {
    Icon: CircleSlash,
    className: "text-[var(--content-tertiary)]",
  },
};

export interface BellRunRowProps {
  item: FeedItem;
  /** Ticking clock, so elapsed time advances without the row owning a timer. */
  nowMs: number;
  onSelect: (item: FeedItem) => void;
  /** Offered on a terminal run the daemon marked retryable. */
  onRetry?: (item: FeedItem) => void;
}

/**
 * A run, live or finished.
 *
 * Updated in place by the feed: the row keeps its identity and its position
 * across progress updates, so the list does not reshuffle under someone
 * reading it.
 */
export function BellRunRow({ item, nowMs, onSelect, onRetry }: BellRunRowProps) {
  const { t } = useTranslation("home");
  const run = item.run;
  if (!run) {
    return null;
  }

  const { Icon, className, spin } = RUN_STATE_ICON[run.state];
  const inFlight = isRunInFlight(item);
  const quiet = isRunQuiet(item, nowMs);

  const childProgress =
    run.childTotal && run.childTotal > 0
      ? t("bellRows.runChildProgress", {
          done: run.childDone ?? 0,
          total: run.childTotal,
        })
      : null;

  const detail = quiet
    ? t("bellRows.runQuiet")
    : (childProgress ??
      run.progressNote ??
      run.failureReason ??
      item.summary);

  return (
    <BellRowShell
      icon={<Icon className={cn("size-4", className, spin && "animate-spin")} />}
      title={resolveFeedItemTitle(item)}
      detail={detail}
      trailing={
        inFlight ? (
          // Tabular figures so the row does not shift width as the seconds
          // roll over.
          <Typography
            variant="body-small-default"
            className="tabular-nums text-[var(--content-tertiary)]"
          >
            {formatRunElapsed(run.startedAt, nowMs)}
          </Typography>
        ) : undefined
      }
      footer={
        !inFlight && run.retryable && onRetry ? (
          <Button
            variant="outlined"
            size="compact"
            leftIcon={<RotateCcw className="size-3.5" />}
            onClick={() => onRetry(item)}
          >
            {t("bellRows.retry")}
          </Button>
        ) : null
      }
      onSelect={() => onSelect(item)}
    />
  );
}

export interface BellSystemHealthRowProps {
  item: FeedItem;
  onSelect: (item: FeedItem) => void;
  /** Navigate to the row's repair affordance, closing the bell. */
  onNavigate: (to: string) => void;
}

/**
 * A subsystem that keeps failing, as one counter rather than one row per
 * failure.
 *
 * The count is the point: a channel dark for two days reads differently from
 * one that missed a single round, and neither is worth a push.
 */
export function BellSystemHealthRow({
  item,
  onSelect,
  onNavigate,
}: BellSystemHealthRowProps) {
  const health = item.systemHealth;
  if (!health) {
    return null;
  }

  return (
    <BellRowShell
      icon={
        <TriangleAlert className="size-4 text-[var(--system-mid-strong)]" />
      }
      title={resolveFeedItemTitle(item)}
      detail={item.summary}
      trailing={
        <Typography
          variant="body-small-default"
          className="tabular-nums text-[var(--content-tertiary)]"
        >
          {`${health.failureCount}×`}
        </Typography>
      }
      footer={
        health.remedyPath && health.remedyLabel ? (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => onNavigate(health.remedyPath!)}
          >
            {health.remedyLabel}
          </Button>
        ) : null
      }
      onSelect={() => onSelect(item)}
    />
  );
}

export interface BellDigestRowProps {
  item: FeedItem;
  /** Opens the full Activity log, which is where the folded rows still are. */
  onOpenActivity: () => void;
}

/**
 * The activity digest: a window of routine finished work folded into one row.
 *
 * Deliberately quiet and deliberately terminal-looking. It summarizes rows
 * that are no longer in the list, so it points at the Activity page rather
 * than expanding in place.
 */
export function BellDigestRow({ item, onOpenActivity }: BellDigestRowProps) {
  const { t } = useTranslation("home");
  return (
    <BellRowShell
      icon={<ActivityIcon className="size-4 text-[var(--content-tertiary)]" />}
      title={item.summary}
      trailing={
        <ChevronRight className="size-4 text-[var(--content-tertiary)]" />
      }
      onSelect={onOpenActivity}
      ariaLabel={t("bellRows.openActivityLog")}
    />
  );
}
