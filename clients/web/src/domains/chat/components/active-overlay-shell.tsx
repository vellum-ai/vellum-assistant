import { type ReactNode, useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/** Design max width of the dropdown (Figma 6063:149685). */
const DROPDOWN_MAX_PX = 589;
/** Min gutter (2rem) kept on each side of the chat column so it never clips. */
const DROPDOWN_GUTTER_PX = 32;

/** Geometry of the dropdown's positioning context, measured from the DOM. */
interface ShellMetrics {
  /** `clientWidth` of the offsetParent (the chat column / positioned ancestor). */
  available: number;
  /** Pill (shell root) left edge, relative to the offsetParent's content box. */
  containerLeft: number;
  /** Pill (shell root) width — the anchor the dropdown centers on. */
  containerWidth: number;
}

export interface ActiveOverlayShellProps {
  /** `data-testid` for the root container (e.g. `"active-workflows-overlay"`). */
  testId: string;
  /** Pre-formatted, already-singularized title, e.g. `"3 Active Workflows"`. */
  title: string;
  /** Renders the pill; receives the current expand state + a toggle handler. */
  renderPill: (args: { expanded: boolean; onToggle: () => void }) => ReactNode;
  /**
   * Renders the mapped inline-card rows shown inside the expanded dropdown.
   * Receives `close()` so a row can drill into its detail panel and dismiss the
   * dropdown in one click (both heavy layers stop competing for column width).
   */
  children: (api: { close: () => void }) => ReactNode;
}

/**
 * Shared chrome for the floating "active X" overlays (subagents, workflows).
 *
 * Owns the expand/collapse state, the dismissal effects (collapse-on-empty is
 * left to callers via their `length === 0` guard; Escape + outside-pointerdown
 * live here), the relative root container, and the absolute dropdown panel with
 * its title. Callers supply the pill (via `renderPill`) and the inline-card rows
 * (via `children`), which are the only things that differ between overlays.
 */
export function ActiveOverlayShell({
  testId,
  title,
  renderPill,
  children,
}: ActiveOverlayShellProps) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // Measured geometry of the bounding chat column. `null` until measured
  // (happy-dom/SSR have no layout) — see the fitted-width fallback below.
  const [metrics, setMetrics] = useState<ShellMetrics | null>(null);

  // Measure the chat column (the shell root's offsetParent — the nearest
  // positioned ancestor) so the dropdown fits the available width instead of
  // the viewport. Re-measure on open, on column resize (live detail-panel
  // width + sidebar collapse both reflow it), and on window resize.
  useEffect(() => {
    const measure = () => {
      const el = containerRef.current;
      const parent = el?.offsetParent as HTMLElement | null;
      const available = parent?.clientWidth ?? 0;
      if (!el || !parent || available <= 0) {
        setMetrics((prev) => (prev === null ? prev : null));
        return;
      }
      const elRect = el.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const containerLeft = elRect.left - parentRect.left;
      const containerWidth = elRect.width;
      // Skip no-op updates: the observer fires on every reflow pixel while a
      // detail panel is dragged, but downstream only cares when a value changed.
      setMetrics((prev) =>
        prev &&
        prev.available === available &&
        prev.containerLeft === containerLeft &&
        prev.containerWidth === containerWidth
          ? prev
          : { available, containerLeft, containerWidth },
      );
    };

    measure();

    const parent = containerRef.current?.offsetParent as HTMLElement | null;
    let observer: ResizeObserver | undefined;
    if (parent && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(parent);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [expanded]);

  // Fitted width: cap at the design max, shrink to the column minus gutters.
  // Unmeasured (happy-dom / pre-measure / detached) → keep the requested max,
  // mirroring `animated-right-drawer`'s "unmeasured container keeps requested
  // width" fallback. Never produce a width <= 0.
  const fittedWidth = metrics
    ? Math.max(1, Math.min(DROPDOWN_MAX_PX, metrics.available - DROPDOWN_GUTTER_PX))
    : DROPDOWN_MAX_PX;

  // Horizontal placement. The transform keeps `x: "-50%"` (centering on the
  // pill); we only adjust the `left` anchor so a far-off-center pill (two
  // pills side by side) can't push the box past either column gutter.
  // Unmeasured → fall back to the `left-1/2` (50%) anchor.
  let dropdownLeft: number | string = "50%";
  if (metrics) {
    const pillCenter = metrics.containerLeft + metrics.containerWidth / 2;
    const boxLeftDefault = pillCenter - fittedWidth / 2;
    const lo = DROPDOWN_GUTTER_PX;
    const hi = metrics.available - DROPDOWN_GUTTER_PX - fittedWidth;
    // When the box can't fit both gutters (very narrow column) center it.
    const boxLeft =
      hi >= lo
        ? Math.max(lo, Math.min(boxLeftDefault, hi))
        : (metrics.available - fittedWidth) / 2;
    // Convert the parent-relative box-left back to the `left` value that, with
    // the `x: "-50%"` transform, lands the box there: left = boxLeft - C + w/2.
    dropdownLeft = boxLeft - metrics.containerLeft + fittedWidth / 2;
  }

  // While open, dismiss on outside pointerdown or Escape.
  useEffect(() => {
    if (!expanded) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Claim Escape so it dismisses only this dropdown, not also an
        // underlying side panel: `ChatContentLayout`'s window keydown handler
        // bails on `event.defaultPrevented`. The listener is attached only
        // while expanded, so reaching here always means we own this Escape.
        event.preventDefault();
        setExpanded(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded]);

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      // Content-width + relative so the pill can sit adjacent to a sibling overlay
      // pill; none here so gutter clicks reach the transcript, pill + panel re-enable.
      className="pointer-events-none relative flex w-auto flex-col items-center"
    >
      {renderPill({ expanded, onToggle: () => setExpanded((v) => !v) })}

      <AnimatePresence>
        {expanded && (
          // Absolute dropdown anchored under the pill so its width no longer
          // dictates the row's width (Figma 6063:149685). Width is fitted to the
          // chat column (see `fittedWidth`) rather than the viewport.
          <motion.div
            // Horizontal centering lives in motion's `x: "-50%"` (not a
            // `-translate-x-1/2` class) so it composes with the animated
            // `scale`/`y` in the same inline `transform` — version-independent
            // of Tailwind's translate-property model.
            className="pointer-events-auto absolute top-full z-20 mt-2 flex flex-col gap-4 rounded-xl bg-[var(--surface-lift)] px-3 py-4 shadow-lg"
            // Width fits the chat column (not the viewport) so a detail panel +
            // sidebar can't clip it; `left` is the clamped anchor that pairs
            // with the `x: "-50%"` transform below.
            style={{ width: fittedWidth, left: dropdownLeft, transformOrigin: "top center" }}
            initial={{ opacity: 0, scale: 0.96, y: -4, x: "-50%" }}
            animate={{ opacity: 1, scale: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, scale: 0.96, y: -4, x: "-50%" }}
            transition={
              reduce ? { duration: 0 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }
            }
          >
            <Typography
              variant="title-small"
              className="text-[var(--content-emphasised)]"
            >
              {title}
            </Typography>
            <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
              {children({ close: () => setExpanded(false) })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
