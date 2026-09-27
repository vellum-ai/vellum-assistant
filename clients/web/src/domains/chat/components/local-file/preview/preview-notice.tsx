import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

interface PreviewNoticeProps {
  /** Already-translated sentence explaining what is not on screen. */
  children: ReactNode;
}

/**
 * Centered one-line status for a preview body with nothing to draw, such as a
 * grid with no columns or a sheet whose part could not be read. Fills the
 * frame so the drawer body does not collapse around the sentence.
 */
export function PreviewNotice({ children }: PreviewNoticeProps): ReactNode {
  return (
    <div role="status" className="flex h-full items-center justify-center p-4">
      <Typography
        as="span"
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {children}
      </Typography>
    </div>
  );
}
