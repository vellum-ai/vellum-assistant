/**
 * Shared outer container + header shell for side-drawer detail panels:
 * rounded lift surface, header row with a leading glyph, truncating title,
 * an optional trailing slot, and the close button. The scrollable body is
 * supplied by the caller as `children`.
 *
 * Used by ToolDetailPanel, ChannelSetupPanel, and any future drawer panels
 * that share the same visual language.
 */

import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button, Typography } from "@vellumai/design-library";

export interface DetailShellProps {
  Glyph: LucideIcon;
  title: string;
  headerTrailing?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function DetailShell({
  Glyph,
  title,
  headerTrailing,
  onClose,
  children,
}: DetailShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-base)] px-5 py-4">
        <Glyph
          className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
          aria-hidden
        />
        <Typography
          variant="title-medium"
          className="min-w-0 shrink truncate py-0.5 leading-snug text-[var(--content-default)]"
        >
          {title}
        </Typography>
        {headerTrailing}
        <span className="flex-1" />
        <Button
          variant="ghost"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close panel"
          tooltip="Close"
          className="shrink-0"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
    </div>
  );
}
