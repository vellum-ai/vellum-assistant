import { useLayoutEffect, type CSSProperties, type ReactNode } from "react";

import { cn } from "@vellumai/design-library";

import { usePageSurfaceStore } from "@/stores/page-surface-store";

/** The surface every shell paints unless a caller overrides it. */
const DEFAULT_SURFACE = "var(--surface-overlay)";

/**
 * Shared rounded-overlay container for the assistant's main content pages
 * (Intelligence "About Assistant" tabs, Library). Keeps the surface,
 * border, padding, and min-h-0 flex behavior consistent across pages so
 * children only own their per-page header/body layout.
 *
 * Also publishes its own background as the page surface, so on the native
 * mobile shells the color reaches the safe areas instead of stopping at the
 * shell's edge. See `page-surface-store`. Overrides are read from
 * `style.backgroundColor` (how `IdentityOverview` applies its avatar tint); a
 * background applied through `className` instead would not be seen here.
 *
 * The border and rounding come off there for the same reason: once the canvas
 * runs edge to edge, they are a box drawn around content that is no longer in
 * one. Desktop keeps both: the card reading as a card is the point.
 *
 * Pass `bleed={false}` when the shell's background is not a flat color it can
 * hand off, such as a blurred photo backdrop. That page keeps its card
 * boundary on every platform and leaves the shell its neutral canvas, which
 * beats publishing a color the content does not actually match.
 */
export function PageShell({
  children,
  className,
  style,
  bleed = true,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  bleed?: boolean;
}) {
  const setPageSurface = usePageSurfaceStore.use.setSurface();
  const surface = style?.backgroundColor ?? DEFAULT_SURFACE;
  // Layout effect, not passive: the page commits and can paint before a
  // passive effect runs, so the safe areas would hold the previous route's
  // color for a frame. Publishing before paint moves the canvas and the
  // content together.
  useLayoutEffect(() => {
    if (!bleed) {
      return;
    }
    setPageSurface(typeof surface === "string" ? surface : DEFAULT_SURFACE);
    return () => {
      setPageSurface(null);
    };
  }, [bleed, surface, setPageSurface]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-6 py-5",
        bleed && "native-mobile:rounded-none native-mobile:border-0",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
