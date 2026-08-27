import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

interface PreviewTruncationNoticeProps {
  /** The already-translated sentence naming how much of the file is shown. */
  children: ReactNode;
}

/**
 * Footer telling the reader a preview is showing part of a file rather than
 * all of it. The readers cap different things (bytes of text, pages of a
 * document), so each supplies its own sentence and this owns only the
 * treatment they share.
 */
export function PreviewTruncationNotice({
  children,
}: PreviewTruncationNoticeProps): ReactNode {
  return (
    <Typography
      as="p"
      variant="label-small-default"
      className="border-t border-[var(--border-element)] pt-2 text-[var(--content-tertiary)]"
    >
      {children}
    </Typography>
  );
}
