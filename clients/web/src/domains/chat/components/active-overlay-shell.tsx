import { type ReactNode, useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

export interface ActiveOverlayShellProps {
  /** `data-testid` for the root container (e.g. `"active-workflows-overlay"`). */
  testId: string;
  /** Pre-formatted, already-singularized title, e.g. `"3 Active Workflows"`. */
  title: string;
  /** Renders the pill; receives the current expand state + a toggle handler. */
  renderPill: (args: { expanded: boolean; onToggle: () => void }) => ReactNode;
  /** The mapped inline-card rows shown inside the expanded dropdown. */
  children: ReactNode;
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

      {expanded && (
        // Absolute dropdown anchored under the pill so its 589px width no longer
        // dictates the row's width (Figma 6063:149685).
        <div className="pointer-events-auto absolute left-1/2 top-full z-20 mt-2 flex w-[min(589px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-4 rounded-xl bg-[var(--surface-lift)] px-3 py-4 shadow-lg">
          <Typography
            variant="title-small"
            className="text-[var(--content-emphasised)]"
          >
            {title}
          </Typography>
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
