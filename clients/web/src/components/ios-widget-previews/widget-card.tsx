/**
 * The Home Screen tile a widget preview is drawn on: the design canvas, the
 * system's corner, and the scale factor every measurement inside is multiplied
 * by.
 *
 * The real views compute `scale = min(width / designWidth, height / designHeight)`
 * and multiply every dimension and font by it, so a card renders at the design's
 * proportions on every device rather than gaining margin on large phones and
 * clipping on small ones. A preview scales the same way, from one arg.
 */

import type { ReactNode } from "react";

import {
  WIDGET_CORNER_RADIUS,
  WIDGET_DESIGN_SIZE,
  WIDGET_FONT_STACK,
  resolveColor,
  type WidgetAppearance,
  type WidgetAppearanceColor,
} from "./widget-tokens";

interface WidgetCardProps {
  family: keyof typeof WIDGET_DESIGN_SIZE;
  /** Multiplier on the design size; 1 renders the card at its design pixels. */
  scale: number;
  appearance: WidgetAppearance;
  /** `containerBackground`: the card behind everything, corner included. */
  background: WidgetAppearanceColor | string;
  children: ReactNode;
}

export function WidgetCard({
  family,
  scale,
  appearance,
  background,
  children,
}: WidgetCardProps) {
  const design = WIDGET_DESIGN_SIZE[family];
  return (
    <div
      style={{
        width: design.width * scale,
        height: design.height * scale,
        borderRadius: WIDGET_CORNER_RADIUS * scale,
        overflow: "hidden",
        position: "relative",
        background:
          typeof background === "string"
            ? background
            : resolveColor(background, appearance),
        fontFamily: WIDGET_FONT_STACK,
        // The Home Screen's own drop shadow, so a white card still reads as a
        // tile against a light Storybook canvas.
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
      }}
    >
      {children}
    </div>
  );
}
