import type { ReactNode } from "react";

import { cn } from "@vellumai/design-library";

export interface AssistantInboxShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * The inbox's own container: a lifted, rounded panel that fills the main
 * area beside the sidebar the way a chat does, so the inbox reads as an app
 * of its own rather than a settings page. Every state of the inbox (upgrade,
 * setup, mail) renders inside this same frame.
 */
export function AssistantInboxShell({
  children,
  className,
}: AssistantInboxShellProps) {
  return (
    <section
      data-testid="assistant-inbox-shell"
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-lift)]",
        className,
      )}
    >
      {children}
    </section>
  );
}
