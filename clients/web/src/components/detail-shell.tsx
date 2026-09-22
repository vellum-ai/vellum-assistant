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
 * header. `DetailShellTitleWithCount` is the "title · N" header cluster, and
 * `DetailShellNotice` and `DetailShellLoading` are the empty and loading
 * states, all exported so every panel draws them from one place.
 */

import type { LucideIcon } from "lucide-react";
import { Loader2, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button, cn, Typography } from "@vellumai/design-library";
import type { TypographyProps } from "@vellumai/design-library";

import { MidlineDot } from "@/components/midline-dot";
import { useTranslation } from "@/i18n";

/**
 * Horizontal inset of `DetailShell`'s header, body, and footer, in px. A host
 * that mounts `DetailShellHeader` on its own insets its own body.
 */
export const DETAIL_SHELL_BODY_INSET_PX = 20;

/**
 * Where a state sits. Under a section heading it is that section's content,
 * so it reads left-aligned beneath the heading; as the whole body there is
 * no heading to hang from, so it is centred with room around it.
 */
export type DetailShellPlacement = "section" | "panel";

/**
 * The quiet line a panel shows where there is nothing to show yet: no runs,
 * no subagents, the tool still running. An error the reader can act on is a
 * design-library `Notice` in its error tone instead, which says it failed and
 * carries the retry.
 */
export function DetailShellNotice({
  placement,
  children,
  ...props
}: {
  placement: DetailShellPlacement;
  children: ReactNode;
  // No `className`: this is the one look for the state, so a panel places it
  // but does not restyle it.
} & Omit<TypographyProps, "as" | "variant" | "children" | "className">) {
  return (
    <Typography
      {...props}
      as="p"
      variant="body-small-default"
      className={cn(
        "text-[var(--content-tertiary)]",
        placement === "panel" && "py-4 text-center",
      )}
    >
      {children}
    </Typography>
  );
}

/**
 * A panel's loading state, announced to assistive tech as a status. Under a
 * section heading it names what is loading beside the spinner; as the whole
 * body the spinner stands alone and the name is its accessible label.
 */
export function DetailShellLoading({
  placement,
  label,
}: {
  placement: DetailShellPlacement;
  /** What is loading. Defaults to the shared catalog's "Loading…". */
  label?: string;
}) {
  const { t } = useTranslation();
  const text = label ?? t("detailShell.loading");
  const spinner = (
    <Loader2
      aria-hidden="true"
      className={cn(
        "shrink-0 animate-spin text-[var(--content-tertiary)] motion-reduce:animate-none",
        placement === "panel" ? "h-5 w-5" : "h-4 w-4",
      )}
    />
  );
  if (placement === "panel") {
    return (
      <div role="status" aria-label={text} className="flex justify-center py-8">
        {spinner}
      </div>
    );
  }
  return (
    <div role="status" className="flex items-center gap-2">
      {spinner}
      <Typography
        as="span"
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {text}
      </Typography>
    </div>
  );
}

/** Header title cluster: title · count, inline at the same size. */
export function DetailShellTitleWithCount({
  title,
  count,
}: {
  title: ReactNode;
  count: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 py-0.5">
      <Typography
        variant="title-medium"
        className="min-w-0 shrink truncate leading-snug text-[var(--content-default)]"
      >
        {title}
      </Typography>
      <MidlineDot />
      <Typography
        variant="title-medium"
        className="shrink-0 whitespace-nowrap leading-snug text-[var(--content-secondary)]"
      >
        {count}
      </Typography>
    </span>
  );
}

export interface DetailShellHeaderProps {
  /** Lucide icon rendered with default sizing/color. Ignored when `icon` is set. */
  Glyph?: LucideIcon;
  /** Pre-rendered icon element (e.g. an <img>). Takes precedence over `Glyph`. */
  icon?: ReactNode;
  title?: string;
  /**
   * Pre-composed title cluster rendered in place of the default truncating
   * `title` Typography, for headers whose title mixes several inline pieces
   * (e.g. the activity-steps panel's "Thinking · 6 steps"). Takes precedence
   * over `title`.
   */
  titleNode?: ReactNode;
  /** Inline slot next to the title (e.g. a status badge), before the spacer. */
  headerTrailing?: ReactNode;
  /** Right-aligned action cluster after the spacer, before close (e.g. a Stop button). */
  headerActions?: ReactNode;
  /**
   * Close-button accessible name. Defaults to the shared catalog's "Close
   * panel"; pass one to name what the panel is ("Close tool details").
   */
  closeLabel?: string;
  /**
   * Close-button hover tooltip. Defaults to the shared catalog's "Close";
   * pass one only to say something different.
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
  closeLabel,
  closeTooltip,
  closeVariant = "outlined",
  onClose,
}: DetailShellHeaderProps) {
  const { t } = useTranslation();
  return (
    // Divider uses `--border-hover` (the Figma sidepanel divider, #F6F5F4 in
    // light) rather than `--border-base`, which equals the drawer's
    // `--surface-lift` in dark mode and would render invisible.
    <div
      className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] py-4"
      style={{ paddingInline: DETAIL_SHELL_BODY_INSET_PX }}
    >
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
        aria-label={closeLabel ?? t("detailShell.closePanel")}
        tooltip={closeTooltip ?? t("detailShell.close")}
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
    <div
      data-slot="detail-shell"
      className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]"
    >
      {headerAbove}
      <DetailShellHeader {...headerProps} />

      {/* Scrollable body */}
      <div
        className="flex-1 overflow-y-auto py-5"
        style={{ paddingInline: DETAIL_SHELL_BODY_INSET_PX }}
      >
        {children}
      </div>

      {/* Pinned footer. Divider uses `--border-hover`, matching the header:
          `--border-base` equals the drawer's `--surface-lift` in dark mode
          and renders invisible. */}
      {footer && (
        <div
          className="shrink-0 border-t border-[var(--border-hover)] py-4"
          style={{ paddingInline: DETAIL_SHELL_BODY_INSET_PX }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
