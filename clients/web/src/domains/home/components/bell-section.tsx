import type { ReactNode } from "react";

import { useTranslation } from "@/i18n";
import type { FeedItemBucket } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

/**
 * Translation key for each section's header, so the label lives with the rest
 * of the home copy rather than inline.
 */
const BUCKET_LABEL_KEY = {
  needs_you: "bellSection.needsYou",
  worth_knowing: "bellSection.worthKnowing",
  activity: "bellSection.activity",
} as const satisfies Record<FeedItemBucket, string>;

export interface BellSectionProps {
  bucket: FeedItemBucket;
  /** Unread rows in this section. Shown on Needs you, where it is a backlog. */
  unreadCount: number;
  /** Live runs in this section. Shown on Activity, where they are the news. */
  runningCount: number;
  children: ReactNode;
}

/**
 * One section of the bell: a quiet header naming the bucket, a count on the
 * right where there is something to count, and the section's rows under it.
 *
 * The header is a label, not a control. Sections have a fixed order and are
 * dropped when empty, so there is nothing to collapse, sort, or filter, and
 * every affordance the header does not have is one the reader does not have to
 * consider.
 */
export function BellSection({
  bucket,
  unreadCount,
  runningCount,
  children,
}: BellSectionProps) {
  const { t } = useTranslation("home");

  // Each section counts the thing it exists for. Needs you counts what is
  // still outstanding; Activity counts what is still moving. Worth knowing
  // counts nothing: it is a list of things that already happened, and a
  // number on it would only be a second unread badge.
  const count =
    bucket === "needs_you" && unreadCount > 0
      ? String(unreadCount)
      : bucket === "activity" && runningCount > 0
        ? t("bellSection.runningCount", { running: runningCount })
        : null;

  return (
    <section className="flex flex-col gap-[var(--app-spacing-sm)]">
      <div className="flex items-baseline gap-[var(--app-spacing-sm)] px-[var(--app-spacing-sm)]">
        <Typography
          variant="body-small-default"
          as="h3"
          className="uppercase tracking-wide text-[var(--content-tertiary)]"
        >
          {t(BUCKET_LABEL_KEY[bucket])}
        </Typography>
        {count ? (
          <Typography
            variant="body-small-default"
            className="ml-auto tabular-nums text-[var(--content-tertiary)]"
          >
            {count}
          </Typography>
        ) : null}
      </div>

      <div className="flex flex-col gap-[var(--app-spacing-sm)]">{children}</div>
    </section>
  );
}
