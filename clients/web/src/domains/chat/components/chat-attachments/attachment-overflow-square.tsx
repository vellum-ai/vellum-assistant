import type { FC } from "react";

import { Typography } from "@vellumai/design-library";

interface AttachmentOverflowSquareProps {
  /** How many attachments are hidden behind this tile. */
  count: number;
  /** Whether this tile's files panel is currently open. */
  active?: boolean;
  onClick: () => void;
}

/**
 * Terminal tile of a truncated attachment strip. Stands in for the
 * attachments past the inline limit and opens the message's files panel.
 */
export const AttachmentOverflowSquare: FC<AttachmentOverflowSquareProps> = ({
  count,
  active = false,
  onClick,
}) => {
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
};
