/**
 * The app's own mark, at the size a control wears it: the icon's green square
 * with the eyes on it.
 *
 * Composed rather than a copy of the icon's artwork, the way the Swift composes
 * it: the icon is eyes on a green ground, and the eye shapes are already here.
 *
 * The ground goes away once the system flattens the widget, because a solid
 * block survives flattening as a solid block and would swallow the eyes on it.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetActionControls.swift
 */

import { WidgetAvatarEyes } from "./widget-avatar-eyes";
import {
  resolveColor,
  widgetTheme,
  type WidgetAppearance,
} from "./widget-tokens";

/** The pair's height as a share of the square. */
const EYE_HEIGHT_RATIO = 0.335;

interface VellumAppIconMarkProps {
  size: number;
  appearance: WidgetAppearance;
  flattened?: boolean;
}

export function VellumAppIconMark({
  size,
  appearance,
  flattened = false,
}: VellumAppIconMarkProps) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: flattened
          ? "transparent"
          : resolveColor(widgetTheme.appIconGround, appearance),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <WidgetAvatarEyes
        eyeHeight={size * EYE_HEIGHT_RATIO}
        appearance={appearance}
        flattened={flattened}
      />
    </span>
  );
}
