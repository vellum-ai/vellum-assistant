/**
 * Shared outer container + header shell for side-drawer detail panels:
 * rounded lift surface, header row with a leading glyph, truncating title,
 * an optional trailing slot, and the close button. The scrollable body is
 * supplied by the caller as `children`.
 *
 * Used by ToolDetailPanel, ChannelSetupPanel, and any future drawer panels
 * that share the same visual language. `DetailShellHeader` is the header row
 * alone, exported for hosts whose body/footer can't fit the default
 * scrollable-body wrapper (e.g. `AcpRunChatView`, which owns its own inner
 * scroll container and a sticky composer) but still need a pixel-identical
 * header.
 */

import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button, Typography } from "@vellumai/design-library";

export interface DetailShellHeaderProps {
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
  /**
   * Close-button hover tooltip. Defaults to the untranslated "Close": fine
   * for domains outside the i18n cutover, but callers whose path is on the
   * `local/no-untranslated-strings` allowlist (see `eslint.config.mjs`) must
   * pass their own `t()`'d copy here instead.
   */
  closeTooltip?: string;
  /** Close-button style. Every current caller uses the bordered "outlined" X. */
  closeVariant?: "ghost" | "outlined";
  onClose: () => void;
}

export function DetailShellHeader({
  Glyph,
  icon,
  title,
  titleNode,
  headerTrailing,
  headerActions,
  closeLabel = "Close panel",
  closeTooltip = "Close",
  closeVariant = "outlined",
  onClose,
}: DetailShellHeaderProps) {
  return (
    // Divider uses `--border-hover` (the Figma sidepanel divider, #F6F5F4 in
    // light) rather than `--border-base`, which equals the drawer's
    // `--surface-lift` in dark mode and would render invisible.
    <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
      {/* The leading cluster absorbs all the shrink (title truncates first,
          then the cluster clips) so the trailing controls, above all the
          close X, stay visible however narrow the panel gets. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        {icon ??
          (Glyph ? (
            <Glyph
              className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
              aria-hidden
            />
          ) : null)}
        {titleNode ?? (
          <Typography
            variant="title-medium"
            title={title}
            // `title-medium` ships a tight line-height; combined with `truncate`
            // (overflow:hidden) it clips descenders (e.g. the "p" in "process").
            // Bump leading + small vertical padding so glyphs get breathing room.
            className="min-w-0 shrink truncate py-0.5 leading-snug text-[var(--content-default)]"
          >
            {title}
          </Typography>
        )}
        {/* `-ml-1.5` trims the cluster's `gap-3` (12px) down to 6px between the
            title and the tag or status badge that sits next to it. Every other
            header gap stays at 12px, since the negative margin only pulls in
            this one edge. */}
        {headerTrailing && (
          <span className="-ml-1.5 flex shrink-0 items-center">
            {headerTrailing}
          </span>
        )}
      </div>
      {headerActions}
      <Button
        variant={closeVariant === "outlined" ? "outlined" : "ghost"}
        iconOnly={<X />}
        onClick={onClose}
        aria-label={closeLabel}
        tooltip={closeTooltip}
        // `-ml-1` trims the row's `gap-3` (12px) down to 8px specifically
        // between Close and whatever `headerActions` renders right before it
        // (a Stop button, "Go to Convo", …). Every other header gap stays at
        // 12px, since the negative margin only pulls in this one edge.
        className={headerActions ? "shrink-0 -ml-1" : "shrink-0"}
      />
    </div>
  );
}

export interface DetailShellProps extends DetailShellHeaderProps {
  /**
   * Row rendered above the header, inside the same rounded surface (e.g. a
   * breadcrumb back to a parent list). Bordered off from the header below
   * with the same divider treatment.
   */
  headerAbove?: ReactNode;
  children: ReactNode;
  /** Pinned action row below the scrollable body (e.g. a primary CTA). */
  footer?: ReactNode;
}

export function DetailShell({
  headerAbove,
  children,
  footer,
  ...headerProps
}: DetailShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {headerAbove}
      <DetailShellHeader {...headerProps} />

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

      {/* Pinned footer. Divider uses `--border-hover`, matching the header:
          `--border-base` equals the drawer's `--surface-lift` in dark mode
          and renders invisible. */}
      {footer && (
        <div className="shrink-0 border-t border-[var(--border-hover)] px-5 py-4">
          {footer}
        </div>
      )}
    </div>
  );
}
