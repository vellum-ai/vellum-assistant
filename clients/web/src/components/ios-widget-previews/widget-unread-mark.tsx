/**
 * The mark a widget says "something is waiting" with: a speech bubble wearing
 * the unseen dot in its top-right corner.
 *
 * The dot rides the bubble's corner at the design's share of it, so the mark
 * scales as one piece rather than drifting off the corner on a card rendered
 * larger.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetActionControls.swift
 */

import { BubbleGlyph } from "./widget-glyphs";
import { widgetTheme, type WidgetAppearance } from "./widget-tokens";

const DOT_DIAMETER_RATIO = 0.375;
const DOT_NUDGE_RATIO = 0.0625;

interface WidgetUnreadMarkProps {
  /** A card painted in the assistant's color wants the filled bubble. */
  filled: boolean;
  size: number;
  /** The bubble takes the color of whatever it is drawn on. */
  color: string;
  appearance?: WidgetAppearance;
  /** Flattened, the dot is the mark's one accentable piece. */
  flattened?: boolean;
}

export function WidgetUnreadMark({
  filled,
  size,
  color,
  appearance = "light",
  flattened = false,
}: WidgetUnreadMarkProps) {
  const dot = size * DOT_DIAMETER_RATIO;
  const nudge = size * DOT_NUDGE_RATIO;
  return (
    <span
      style={{ position: "relative", display: "inline-flex", lineHeight: 0 }}
      aria-hidden="true"
    >
      <BubbleGlyph size={size} color={color} filled={filled} />
      <span
        style={{
          position: "absolute",
          top: -nudge,
          right: -nudge,
          width: dot,
          height: dot,
          borderRadius: "50%",
          background: flattened
            ? "#FFFFFF"
            : widgetTheme.unseenIndicator[appearance],
        }}
      />
    </span>
  );
}
