import type { ReactNode } from "react";

import { cn } from "@vellumai/design-library";

export interface AssistantInboxShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * The inbox's frame: it fills the main area beside the sidebar the way a
 * chat does, on the page ground, and the surfaces inside it (the mail
 * cards, the setup and upgrade cards) are what lift off it. No panel of its
 * own, so the inbox reads as part of the app rather than a window in it.
 */
export function AssistantInboxShell({
  children,
  className,
}: AssistantInboxShellProps) {
  return (
    <section
      data-testid="assistant-inbox-shell"
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden",
        className,
      )}
    >
      {children}
    </section>
  );
}
