import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

/** Shown for a file that parsed cleanly but holds nothing the preview renders. */
const PREVIEW_EMPTY_MESSAGE = "Nothing to preview in this file";

/**
 * Empty state for a document whose readable content is all in parts the
 * previews leave out, such as a Word file whose body is one blank paragraph and
 * whose text lives entirely in headers and footers.
 */
export function PreviewEmpty(): ReactNode {
  return (
    <div role="status" className="flex h-full items-center justify-center p-4">
      <Typography
        as="span"
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {PREVIEW_EMPTY_MESSAGE}
      </Typography>
    </div>
  );
}
