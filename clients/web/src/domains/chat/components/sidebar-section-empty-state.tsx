/**
 * What a sidebar section says when it has no rows.
 *
 * The one layout every empty section draws in: a short title, a quieter line
 * under it, and an optional action, centred in the section's card. The
 * sections that can be empty (the assistant's own and Chats) supply their
 * own copy; the shape is here so the two cannot drift apart.
 *
 * Deliberately smaller than `EmptyStateScene`: this sits inside a sidebar
 * card a couple of hundred pixels wide, where that component's icon well and
 * recipe grid do not fit. No hero glyph either: the section's own mark
 * already stands in the header a line above.
 */

import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

export function SidebarSectionEmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-[var(--app-spacing-sm)] px-[var(--app-spacing-md)] pt-[var(--app-spacing-sm)] pb-[var(--app-spacing-md)] text-center">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
      >
        {title}
      </Typography>
      <Typography
        variant="body-small-lighter"
        className="text-balance text-[var(--content-tertiary)]"
      >
        {body}
      </Typography>
      {action}
    </div>
  );
}
