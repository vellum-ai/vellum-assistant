/* eslint-disable local/no-untranslated-strings --
 * The literals here are not this app's copy. They reproduce strings hardcoded
 * in the widgets' Swift, which ships in English only and never reads this app's
 * catalogs: a widget renders in an extension process that does not run the SPA.
 * Routing them through `t()` would assert a localization the widgets do not
 * have, and would let a catalog edit silently drift the preview away from the
 * card it is a picture of. The rule also reports the rgba style values below,
 * which are not copy at all.
 */
/**
 * The Quick Actions widget: the two most physical ways to start something, on
 * a card painted in the assistant's own colors, plus the assistant looking up
 * when something is waiting.
 *
 * Every measurement below is the constant of the same name in the Swift, on the
 * same 160x161 design canvas.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/QuickActionsWidget.swift
 */

import { CameraGlyph, WaveformGlyph } from "./widget-glyphs";
import {
  DEFAULT_EYE_HEIGHT,
  EYE_PAIR_ASPECT,
  WidgetAvatarEyes,
} from "./widget-avatar-eyes";
import { WidgetCard } from "./widget-card";
import { WidgetUnreadMark } from "./widget-unread-mark";
import {
  avatarPalette,
  resolveColor,
  type WidgetAppearance,
} from "./widget-tokens";

const CONTENT_MARGIN = 16;
const CONTROL_DIAMETER = 61;
const CONTROL_GAP = 6;
const AVATAR_IMAGE_SIZE = 44;
const AVATAR_IMAGE_CORNER_RADIUS = 15;
const MARK_INSET = 13;
const MARK_LEADING_INSET = 2;
/** How far right of centre the quiet mark rests, leaning into the glance. */
const QUIET_MARK_CENTER_OFFSET = 11.5;
const CHIP_HEIGHT = 31;
const CHIP_FILL = "rgba(0, 0, 0, 0.10)";
const FLATTENED_CHIP_FILL = "rgba(255, 255, 255, 0.12)";
const FLATTENED_CIRCLE_FILL = "rgba(255, 255, 255, 0.14)";
const CONTROL_FILL_ON_WHITE = 0.14;
const CONTROL_FILL_ON_DARK = 0.1;
const MARK_CHIP_GAP = 12;

/** `chipAllowance(for:scale:)`: the width the chip needs at this count. */
function chipAllowance(count: number, scale: number): number {
  const glyphs = count > 99 ? 3 : String(count).length;
  return (45 + 9.5 * glyphs) * scale;
}

export interface QuickActionsWidgetPreviewProps {
  scale?: number;
  appearance?: WidgetAppearance;
  /** The count on the chip. `null` draws the quiet card. */
  unreadCount?: number | null;
  /** The avatar's accent, or `null` for the account with no avatar at all. */
  accentHex?: string | null;
  /** A custom photo, drawn in place of the eyes and blurred into the card. */
  avatarImageUrl?: string | null;
  /** The system's monochrome modes: a themed Home Screen, StandBy, the lock screen. */
  flattened?: boolean;
}

export function QuickActionsWidgetPreview({
  scale = 1,
  appearance = "light",
  unreadCount = null,
  accentHex = "#0E9B8B",
  avatarImageUrl = null,
  flattened = false,
}: QuickActionsWidgetPreviewProps) {
  const palette = avatarPalette(accentHex);
  const onSurface = flattened
    ? "#FFFFFF"
    : resolveColor(palette.onSurface, appearance);
  const controlFill = flattened
    ? FLATTENED_CIRCLE_FILL
    : resolveColor(
        palette.controlFill(CONTROL_FILL_ON_WHITE, CONTROL_FILL_ON_DARK),
        appearance,
      );
  const background = flattened
    ? "rgba(30, 30, 32, 1)"
    : resolveColor(palette.surface, appearance);

  const contentWidth = 160 * scale - CONTENT_MARGIN * scale * 2;
  const markWidth =
    unreadCount === null
      ? contentWidth
      : contentWidth -
        chipAllowance(unreadCount, scale) -
        MARK_CHIP_GAP * scale;

  return (
    <WidgetCard
      family="small"
      scale={scale}
      appearance={appearance}
      background={background}
    >
      {avatarImageUrl !== null && !flattened ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `url(${avatarImageUrl})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "blur(18px)",
            transform: "scale(1.3)",
          }}
        />
      ) : null}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: CONTENT_MARGIN * scale,
          boxSizing: "border-box",
        }}
      >
        {unreadCount === null ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              paddingTop: MARK_INSET * scale,
              transform: `translateX(${QUIET_MARK_CENTER_OFFSET * scale}px)`,
            }}
          >
            <AvatarMark
              eyeHeight={DEFAULT_EYE_HEIGHT * scale}
              imageSize={AVATAR_IMAGE_SIZE * scale}
              cornerRadius={AVATAR_IMAGE_CORNER_RADIUS * scale}
              appearance={appearance}
              avatarImageUrl={avatarImageUrl}
              flattened={flattened}
            />
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              paddingTop: MARK_INSET * scale,
            }}
          >
            <div style={{ paddingLeft: MARK_LEADING_INSET * scale }}>
              <AvatarMark
                eyeHeight={fittedEyeHeight(markWidth, scale)}
                imageSize={fittedImageSize(markWidth, scale)}
                cornerRadius={AVATAR_IMAGE_CORNER_RADIUS * scale}
                appearance={appearance}
                avatarImageUrl={avatarImageUrl}
                flattened={flattened}
              />
            </div>
            <div style={{ flex: 1 }} />
            <UnreadChip
              count={unreadCount}
              scale={scale}
              onSurface={onSurface}
              flattened={flattened}
            />
          </div>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: CONTROL_GAP * scale }}>
          <CircleAction
            diameter={CONTROL_DIAMETER * scale}
            fill={controlFill}
            label="Take a photo"
          >
            <CameraGlyph
              size={CONTROL_DIAMETER * scale * 0.4}
              color={onSurface}
            />
          </CircleAction>
          <CircleAction
            diameter={CONTROL_DIAMETER * scale}
            fill={controlFill}
            label="New voice conversation"
          >
            <WaveformGlyph
              size={CONTROL_DIAMETER * scale * 0.4}
              color={onSurface}
            />
          </CircleAction>
        </div>
      </div>
    </WidgetCard>
  );
}

/** `fittedEyeHeight(in:scale:)`: what the chip leaves the eyes. */
function fittedEyeHeight(markWidth: number, scale: number): number {
  const available = markWidth / EYE_PAIR_ASPECT;
  return Math.min(DEFAULT_EYE_HEIGHT * scale, Math.max(24 * scale, available));
}

/** `fittedImageSize(in:scale:)`: the photo mark under the same constraint. */
function fittedImageSize(markWidth: number, scale: number): number {
  return Math.min(AVATAR_IMAGE_SIZE * scale, Math.max(24 * scale, markWidth));
}

function AvatarMark({
  eyeHeight,
  imageSize,
  cornerRadius,
  appearance,
  avatarImageUrl,
  flattened,
}: {
  eyeHeight: number;
  imageSize: number;
  cornerRadius: number;
  appearance: WidgetAppearance;
  avatarImageUrl: string | null;
  flattened: boolean;
}) {
  if (avatarImageUrl !== null) {
    return (
      <img
        src={avatarImageUrl}
        alt=""
        style={{
          width: imageSize,
          height: imageSize,
          borderRadius: cornerRadius,
          objectFit: "cover",
          // `widgetAccentedRenderingMode(.accentedDesaturated)`.
          filter: flattened ? "grayscale(1) brightness(1.4)" : undefined,
        }}
      />
    );
  }
  return (
    <WidgetAvatarEyes
      eyeHeight={eyeHeight}
      appearance={appearance}
      flattened={flattened}
    />
  );
}

/**
 * The chip is a tap target on the device, running `OpenConversationsIntent`.
 * Rendered flat here: a preview has no app to open, and drawing a hover state
 * the widget does not have would be a lie about the card.
 */
function UnreadChip({
  count,
  scale,
  onSurface,
  flattened,
}: {
  count: number;
  scale: number;
  onSurface: string;
  flattened: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5 * scale,
        height: CHIP_HEIGHT * scale,
        padding: `0 ${10 * scale}px`,
        borderRadius: (CHIP_HEIGHT * scale) / 2,
        background: flattened ? FLATTENED_CHIP_FILL : CHIP_FILL,
        color: onSurface,
      }}
    >
      <WidgetUnreadMark filled={false} size={16 * scale} color={onSurface} />
      <span
        style={{
          fontSize: 16 * scale,
          fontWeight: 500,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count > 99 ? "99+" : count}
      </span>
    </div>
  );
}

function CircleAction({
  diameter,
  fill,
  label,
  children,
}: {
  diameter: number;
  fill: string;
  label: string;
  children: React.ReactNode;
}) {
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
