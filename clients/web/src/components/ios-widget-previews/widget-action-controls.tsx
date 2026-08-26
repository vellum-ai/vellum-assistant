/**
 * The controls every card builds itself out of: the action tile, and the round
 * one beside it.
 *
 * One implementation each, for the reason the Swift gives for collecting them
 * in `WidgetActionControls.swift`: a control that lives in one widget's file is
 * a control the next widget copies, and a fidelity correction then lands on one
 * card and not the other.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetActionControls.swift
 */

import type { ReactNode } from "react";

/** `WidgetActionTile`: a corner tighter than the widget's own squircle. */
const TILE_CORNER_RADIUS = 12;
const TILE_ICON_SIZE = 24;
const TILE_LABEL_SIZE = 8;
const TILE_GLYPH_LABEL_GAP = 4;

/** The tile's icon size, for callers sizing a glyph to hand in. */
export const WIDGET_TILE_ICON_SIZE = TILE_ICON_SIZE;

interface WidgetActionTileProps {
  /** The owning card's ratio to the size it was designed at. */
  scale: number;
  label: string;
  fill: string;
  labelColor: string;
  icon: ReactNode;
}

export function WidgetActionTile({
  scale,
  label,
  fill,
  labelColor,
  icon,
}: WidgetActionTileProps) {
  return (
    <div
      style={{
        flex: 1,
        borderRadius: TILE_CORNER_RADIUS * scale,
        background: fill,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: TILE_GLYPH_LABEL_GAP * scale,
      }}
    >
      {icon}
      <span
        style={{
          fontSize: TILE_LABEL_SIZE * scale,
          fontWeight: 500,
          color: labelColor,
        }}
      >
        {label}
      </span>
    </div>
  );
}

interface WidgetCircleActionProps {
  diameter: number;
  fill: string;
  /** What the control is for, since the glyph is its whole label. */
  label: string;
  children: ReactNode;
}

/** `CircleActionButton`: a round target with the glyph as its whole label. */
export function WidgetCircleAction({
  diameter,
  fill,
  label,
  children,
}: WidgetCircleActionProps) {
  return (
    <div
      role="img"
      aria-label={label}
      style={{
        width: diameter,
        height: diameter,
        borderRadius: "50%",
        background: fill,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </div>
  );
}
