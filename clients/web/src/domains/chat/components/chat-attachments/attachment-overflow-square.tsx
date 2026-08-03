import { Typography } from "@vellumai/design-library";

interface AttachmentOverflowSquareProps {
  /** How many attachments are hidden behind this tile. */
  count: number;
  onClick: () => void;
  /** Whether this tile's files panel is currently open. */
  active?: boolean;
}

/**
 * Terminal tile of a truncated attachment strip. Stands in for the
 * attachments past the inline limit.
 */
export function AttachmentOverflowSquare({
  count,
  onClick,
  active = false,
}: AttachmentOverflowSquareProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show all files (${count} more)`}
      title={`${count} more`}
      className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed transition-colors ${
        active
          ? "border-[var(--border-hover)] bg-[var(--surface-lift)]"
          : "border-[var(--border-base)] hover:bg-[var(--surface-lift)]"
      }`}
    >
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
      >
        +{count}
      </Typography>
    </button>
  );
}
