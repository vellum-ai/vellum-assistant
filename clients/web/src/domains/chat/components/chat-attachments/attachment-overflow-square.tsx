import type { FC } from "react";

import { Typography } from "@vellumai/design-library";

interface AttachmentOverflowSquareProps {
  /** How many attachments are hidden behind this tile. */
  count: number;
  onClick: () => void;
}

/**
 * Terminal tile of a truncated attachment strip. Stands in for the
 * attachments past the inline limit.
 */
export const AttachmentOverflowSquare: FC<AttachmentOverflowSquareProps> = ({
  count,
  onClick,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show all files (${count} more)`}
      title={`${count} more`}
      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--border-base)] transition-colors hover:bg-[var(--surface-lift)]"
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
