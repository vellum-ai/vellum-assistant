/**
 * The app's own mark, at the size a control wears it: an icon ground with the
 * icon's own eyes on it.
 *
 * The eyes are the avatar library's `quirky` style, read from the bundled copy
 * this app already ships rather than traced again. That is the same geometry
 * the Icon Composer bundles embed and the same the widget extension draws, so
 * this preview shows the mark rather than something the shape of it. Notably it
 * is NOT `WidgetAvatarEyes`: that pair is a 61x33 egg arrangement while the
 * icon's is 233x176 in its own canvas, and they do not read alike.
 *
 * The ground is per environment on the device, where each build carries its own
 * icon's fill. A story has no build to ask, so it takes one.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetActionControls.swift
 * @see clients/ios/App/App/Shared/AppIconGround.swift
 */

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/** The three grounds the Icon Composer bundles declare, in sRGB. */
export const APP_ICON_GROUNDS = {
  production: "#4E9857",
  staging: "#E7C91A",
  dev: "#FF88C9",
} as const;

export type AppIconEnvironment = keyof typeof APP_ICON_GROUNDS;

const QUIRKY = BUNDLED_COMPONENTS.eyeStyles.find(
  (style) => style.id === "quirky",
);

/** A corner in the family the icon's own squircle is drawn with. */
const CORNER_RADIUS_RATIO = 0.28;

/**
 * How much of the square the artwork's canvas is blown up to, mirroring the
 * scale and offset the icon applies rather than drawing the canvas edge to
 * edge: the pair occupies only the middle third of it.
 */
const ARTWORK_SCALE = 1.94;
const ARTWORK_OFFSET_X_RATIO = 0.074;

interface VellumAppIconMarkProps {
  size: number;
  /** Which build's icon to draw. Defaults to the one users install. */
  environment?: AppIconEnvironment;
  flattened?: boolean;
}

export function VellumAppIconMark({
  size,
  environment = "production",
  flattened = false,
}: VellumAppIconMarkProps) {
  if (QUIRKY === undefined) {
    return null;
  }
  const { width, height } = QUIRKY.sourceViewBox;
  const artwork = size * ARTWORK_SCALE;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size * CORNER_RADIUS_RATIO,
        background: flattened ? "transparent" : APP_ICON_GROUNDS[environment],
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      aria-hidden="true"
    >
      <svg
        width={artwork}
        height={artwork}
        viewBox={`0 0 ${width} ${height}`}
        style={{
          flexShrink: 0,
          transform: `translateX(${size * ARTWORK_OFFSET_X_RATIO}px)`,
          // Flattened, the system keeps alpha and throws the colors away.
          opacity: flattened ? 0.85 : 1,
        }}
      >
        {QUIRKY.paths.map((path, index) => (
          <path
            key={index}
            d={path.svgPath}
            fill={flattened ? "#FFFFFF" : path.color}
          />
        ))}
      </svg>
    </span>
  );
}
