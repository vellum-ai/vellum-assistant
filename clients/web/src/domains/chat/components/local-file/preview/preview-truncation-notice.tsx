import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

interface PreviewTruncationNoticeProps {
  /** The already-translated sentence naming how much of the file is shown. */
  children: ReactNode;
  /**
   * Root element. A reader that renders inline in chat markdown sits inside
   * a paragraph, where a nested `p` is invalid and closes its parent early,
   * so those pass `"span"`. The block class keeps the layout identical.
   */
  as?: "p" | "span";
}

/**
 * Footer telling the reader a preview is showing part of a file rather than
 * all of it. A reader caps whatever unit it measures in and supplies the
 * sentence saying so, leaving this to own only the treatment they share.
 */
export function PreviewTruncationNotice({
  children,
  as = "p",
}: PreviewTruncationNoticeProps): ReactNode {
  return (
    <Typography
      as={as}
      variant="label-small-default"
      className="block border-t border-[var(--border-element)] pt-2 text-[var(--content-tertiary)]"
    >
      {children}
    </Typography>
  );
}
