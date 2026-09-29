import { ChevronRight } from "lucide-react";

import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";
import { openDetailSheetFromTrigger } from "@/domains/chat/utils/open-detail-sheet-from-trigger";
import { cn } from "@/utils/misc";

export interface ActivityLinkButtonProps {
  dataTestId: string;
  ariaLabel: string;
  label: string;
  /**
   * When `true`, the label renders through {@link StreamingShimmerText}, the
   * avatar-tinted gradient glint that marks in-flight work.
   */
  shimmerLabel?: boolean;
  tone: "default" | "error";
  active: boolean;
  onClick: () => void;
}

/**
 * A one-line activity link in the transcript: a label that opens a detail
 * drawer, shimmering while its work is in flight. Shared by `SingleActivity`
 * and the quiet-turn progress line so both read and behave as one control.
 */
export function ActivityLinkButton({
  dataTestId,
  ariaLabel,
  label,
  shimmerLabel,
  tone,
  active,
  onClick,
}: ActivityLinkButtonProps) {
  const isError = tone === "error";
  return (
    <button
      type="button"
      data-testid={dataTestId}
      data-active={active ? "true" : "false"}
      aria-label={ariaLabel}
      onClick={(event) => openDetailSheetFromTrigger(event, onClick)}
      className={cn(
        "group inline-flex items-center gap-2 -mx-1.5 px-1.5 py-1 rounded-md text-left text-[13px] font-medium transition-colors cursor-pointer",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]",
        active
          ? "bg-[var(--surface-active)] text-[var(--content-default)]"
          : "text-[var(--content-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        isError && "text-[var(--system-negative-strong)]",
      )}
    >
      <span className="min-w-0 max-w-[min(520px,calc(100vw-8rem))] truncate">
        {shimmerLabel ? (
          <StreamingShimmerText data-testid="thought-process-loading">
            {label}
          </StreamingShimmerText>
        ) : (
          label
        )}
      </span>
      {/* The chevron is an affordance, not a status: it appears when the row is
          reachable (hover / keyboard focus) or already showing its drawer, so a
          settled run of rows reads as labels instead of a column of glyphs.
          Faded rather than unmounted so the label never shifts. */}
      <ChevronRight
        className="size-3.5 shrink-0 text-[var(--content-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[active=true]:opacity-100 motion-reduce:transition-none"
        aria-hidden
      />
    </button>
  );
}
