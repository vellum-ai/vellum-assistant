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
  /** Lucide icon rendered with default sizing/color. Ignored when `icon` is set. */
  Glyph?: LucideIcon;
  /** Pre-rendered icon element (e.g. an <img>). Takes precedence over `Glyph`. */
  icon?: ReactNode;
  title?: string;
  /**
   * Pre-composed title cluster rendered in place of the default truncating
   * `title` Typography — for headers whose title mixes several inline pieces
   * (e.g. the activity-steps panel's "Thinking · 6 steps"). Takes precedence
   * over `title`.
   */
  titleNode?: ReactNode;
  /** Inline slot next to the title (e.g. a status badge), before the spacer. */
  headerTrailing?: ReactNode;
  /** Right-aligned action cluster after the spacer, before close (e.g. a Stop button). */
  headerActions?: ReactNode;
  closeLabel?: string;
  /** Close-button style. "outlined" matches the subagent panel's bordered X. */
  closeVariant?: "ghost" | "outlined";
  onClose: () => void;
  children: ReactNode;
  /** Pinned action row below the scrollable body (e.g. a primary CTA). */
  footer?: ReactNode;
}

export function DetailShell({
  Glyph,
  icon,
  title,
  titleNode,
  headerTrailing,
  headerActions,
  closeLabel = "Close panel",
  closeVariant = "ghost",
  onClose,
  children,
  footer,
}: DetailShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Header. Divider uses `--border-hover` (the Figma sidepanel divider,
          #F6F5F4 in light) rather than `--border-base`, which equals the
          drawer's `--surface-lift` in dark mode and would render invisible. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
        {icon ?? (Glyph ? (
          <Glyph
            className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
            aria-hidden
          />
        ) : null)}
        {titleNode ?? (
          <Typography
            variant="title-medium"
            // `title-medium` ships a tight line-height; combined with `truncate`
            // (overflow:hidden) it clips descenders (e.g. the "p" in "process").
            // Bump leading + small vertical padding so glyphs get breathing room.
            className="min-w-0 shrink truncate py-0.5 leading-snug text-[var(--content-default)]"
          >
            {title}
          </Typography>
        )}
        {headerTrailing}
        <span className="flex-1" />
        {headerActions}
        <Button
          variant={closeVariant === "outlined" ? "outlined" : "ghost"}
          iconOnly={<X />}
          onClick={onClose}
          aria-label={closeLabel}
          tooltip="Close"
          className={`shrink-0${closeVariant === "outlined" ? " rounded-lg" : ""}`}
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

      {/* Pinned footer */}
      {footer && (
        <div className="shrink-0 border-t border-[var(--border-base)] px-5 py-4">
          {footer}
        </div>
      )}
    </div>
  );
}
