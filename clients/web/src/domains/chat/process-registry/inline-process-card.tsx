// Generic inline progress row shared by the four background-process surfaces
// (subagent / workflow / ACP run / background task). The leading cluster is the
// open affordance; the stop button stays a separate sibling so it isn't nested
// inside an interactive element.
//
// Pure presentational: callers project their store state into a `CardSummary`
// and supply the per-surface leading icon + handlers. No store reads here.

import { Square } from "lucide-react";
import { useCallback, type MouseEvent, type ReactNode } from "react";

import { Button, Typography } from "@vellumai/design-library";

import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
import { InlineCardStatusIcon } from "@/domains/chat/process-registry/inline-card-status-icon";
import type { CardSummary } from "@/domains/chat/process-registry/types";
import { useTranslation } from "@/i18n";

export interface InlineProcessCardProps {
  /** Pre-projected summary driving the status icon, title, info, and count. */
  summary: CardSummary;
  /** Per-surface leading glyph/avatar rendered after the status icon. */
  leadingIcon: ReactNode;
  /** Static accessible label for the open affordance, e.g. `"Open workflow"`. */
  openAriaLabel: string;
  /** Opens the process's detail panel; omit to make the leading cluster inert. */
  onOpen?: () => void;
  /** Stops the in-flight process; omit to hide the stop button. */
  onStop?: () => void;
  /** Accessible label for the stop button; defaults to `"Stop"`. */
  stopAriaLabel?: string;
  /**
   * Custom count slot. When provided, replaces the default string-count
   * `Typography` (e.g. the workflow agent-avatar chip).
   */
  countSlot?: ReactNode;
  /** `data-testid` for the root row. */
  testId?: string;
}

export function InlineProcessCard({
  summary,
  leadingIcon,
  openAriaLabel,
  onOpen,
  onStop,
  stopAriaLabel,
  countSlot,
  testId,
}: InlineProcessCardProps) {
  const { t } = useTranslation("chat");
  const handleStop = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onStop?.();
    },
    [onStop],
  );

  // Hidden for 0/1-count rows where the carousel detail already says it.
  const { count } = summary;
  const showCount =
    !!count && !count.startsWith("0 ") && !count.startsWith("1 ");

  // Without a click handler the leading cluster is inert (not a button).
  const canOpen = !!onOpen;

  const leadingCluster = (
    <>
      <InlineCardStatusIcon state={summary.state} />
      <span className="mx-1 flex shrink-0 items-center">{leadingIcon}</span>
      <HeaderStepCarousel
        currentStepTitle={summary.title}
        currentStepInfo={summary.info}
        bypassDwell={summary.state !== "loading"}
      />
    </>
  );

  return (
    <div
      data-testid={testId}
      className="group flex w-full items-center justify-between gap-2 rounded-md p-2 text-left hover:bg-[var(--surface-active)]"
    >
      {canOpen ? (
        <button
          type="button"
          aria-label={openAriaLabel}
          onClick={onOpen}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
        >
          {leadingCluster}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1 text-left">
          {leadingCluster}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {countSlot != null ? (
          countSlot
        ) : showCount ? (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid="inline-process-card-count"
          >
            {count}
          </Typography>
        ) : null}
        {onStop && summary.state === "loading" ? (
          <Button
            variant="dangerGhost"
            size="compact"
            iconOnly={<Square />}
            aria-label={stopAriaLabel ?? t("inlineProcessCard.stop")}
            data-testid="inline-process-card-stop"
            onClick={handleStop}
          />
        ) : null}
      </div>
    </div>
  );
}
