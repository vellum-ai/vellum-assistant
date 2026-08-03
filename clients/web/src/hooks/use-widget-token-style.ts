/**
 * The `<style>` block carrying the host's resolved design tokens for a widget.
 *
 * The values are read off the live document with `getComputedStyle`, so a read
 * taken before the app's stylesheet has applied resolves every custom property
 * to the empty string. That snapshot has no natural invalidation — the theme
 * does not change and the inlined-font snapshot can resolve to the same empty
 * string it started at — so an unresolved read is re-probed on the following
 * frames until the tokens land. Once they do, the returned style changes, which
 * changes the widget's `srcdoc` and remounts its frame with a themed document.
 *
 * @see {@link @/utils/widget-tokens}
 */

import { useEffect, useState } from "react";

import { buildWidgetStyle } from "@/utils/widget-tokens";

/**
 * Frames to keep re-probing an unresolved token snapshot. Roughly half a second
 * at 60fps — long enough to outlast a stylesheet that is still in flight, short
 * enough that a host which genuinely declares no tokens stops probing.
 */
const MAX_TOKEN_PROBE_FRAMES = 30;

export function useWidgetTokenStyle(theme: string): string {
  const [snapshot, setSnapshot] = useState(() => buildWidgetStyle(theme));
  const [snapshotTheme, setSnapshotTheme] = useState(theme);

  // The token values belong to the theme they were read under, so a theme flip
  // re-reads during render rather than showing the previous theme's document
  // for a frame.
  if (snapshotTheme !== theme) {
    setSnapshotTheme(theme);
    setSnapshot(buildWidgetStyle(theme));
  }

  useEffect(() => {
    if (snapshot.resolved || typeof requestAnimationFrame !== "function") {
      return;
    }
    let frames = 0;
    let handle = 0;
    const probe = () => {
      const next = buildWidgetStyle(theme);
      if (next.resolved) {
        setSnapshot(next);
        return;
      }
      frames += 1;
      if (frames >= MAX_TOKEN_PROBE_FRAMES) {
        return;
      }
      handle = requestAnimationFrame(probe);
    };
    handle = requestAnimationFrame(probe);
    return () => cancelAnimationFrame(handle);
  }, [theme, snapshot.resolved]);

  return snapshot.style;
}
