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
import { WidgetCircleAction } from "./widget-action-controls";
import { WidgetCard } from "./widget-card";
import { WidgetUnreadMark } from "./widget-unread-mark";
import { SURFACE_GROUND } from "@/utils/avatar-tone";

import {
  avatarPalette,
  FLATTENED_CARD_GROUND,
  resolveColor,
  themeAccentHex,
  type WidgetAppearance,
  type WidgetAvatarKind,
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

/** `BlurredAvatarBackground`: the card a custom photo makes. */
const AVATAR_BLUR_RADIUS = 30;
const AVATAR_BLUR_OVERSCAN = AVATAR_BLUR_RADIUS * 2;
const AVATAR_SCRIM_OPACITY = 0.55;

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
  /**
   * Which of the three avatar treatments the card draws. The kind decides,
   * never the presence of a raster: a character carries its accent and its
   * encoded face together.
   */
  avatarKind?: WidgetAvatarKind;
  /** The avatar's accent. Read only for a character; see `themeAccentHex`. */
  accentHex?: string | null;
  /**
   * The raster the snapshot carries. An `image` avatar draws it as the mark and
   * blurs it into the card; a character keeps its eyes and leaves this to the
   * surfaces that show the whole avatar.
   */
  avatarImageUrl?: string | null;
  /**
   * Whether the snapshot behind this card is old enough that its count is a
   * claim about an inbox from half an hour ago. The chip drops; the face does
   * not, because whose assistant this is stays true.
   */
  isStale?: boolean;
  /** The system's monochrome modes: a themed Home Screen, StandBy, the lock screen. */
  flattened?: boolean;
}

export function QuickActionsWidgetPreview({
  scale = 1,
  appearance = "light",
  unreadCount = null,
  avatarKind = "character",
  accentHex = "#0E9B8B",
  avatarImageUrl = null,
  isStale = false,
  flattened = false,
}: QuickActionsWidgetPreviewProps) {
  const palette = avatarPalette(themeAccentHex(avatarKind, accentHex));
  const onSurface = flattened
    ? "#FFFFFF"
    : resolveColor(palette.onSurface, appearance);
  const controlFill = flattened
    ? FLATTENED_CIRCLE_FILL
    : resolveColor(
        palette.controlFill(CONTROL_FILL_ON_WHITE, CONTROL_FILL_ON_DARK),
        appearance,
      );
  // `QuickActionsCardBackground`: a photo avatar makes the card the blurred
  // photo over its own near-black ground, not the accent, since an uploaded
  // avatar carries no accent to tint with.
  // One owner of "is this card wearing a photo", so the placement and the mark
  // cannot disagree and hang the photo off a line drawn for something else.
  const drawsPhotoMark = avatarKind === "image" && avatarImageUrl !== null;
  const hasPhotoCard = drawsPhotoMark && !flattened;
  // The eyes lean past centre into the rightward glance their pupils already
  // have. A photo has no glance to lean into, and the same nudge only reads as
  // a square hung crooked, so it sits on the line.
  const quietMarkOffset = drawsPhotoMark ? 0 : QUIET_MARK_CENTER_OFFSET;
  const background = flattened
    ? FLATTENED_CARD_GROUND
    : hasPhotoCard
      ? SURFACE_GROUND
      : resolveColor(palette.surface, appearance);

  // `QuickActionsEntry.unreadCount`: nil unless something is actually waiting
  // and the snapshot is fresh enough to be counting. An ordinary zero draws the
  // quiet card rather than a `0` chip, and a stale snapshot drops the tally
  // while keeping the face: a count says how many are waiting NOW, which is
  // exactly what a widget cannot see while the app is closed.
  const chipCount =
    !isStale && unreadCount !== null && unreadCount > 0 ? unreadCount : null;
  const contentWidth = 160 * scale - CONTENT_MARGIN * scale * 2;
  const markWidth =
    chipCount === null
      ? contentWidth
      : contentWidth - chipAllowance(chipCount, scale) - MARK_CHIP_GAP * scale;

  return (
    <WidgetCard
      family="small"
      scale={scale}
      appearance={appearance}
      background={background}
    >
      {hasPhotoCard ? (
        <>
          {/* `BlurredAvatarBackground`: the blur samples transparency past the
              layer's edge, so the photo grows beyond the card by twice the
              radius per side and the clip trims the excess. Without that the
              perimeter fades into the ground. */}
          <div
            style={{
              position: "absolute",
              inset: -AVATAR_BLUR_OVERSCAN * scale,
              // Quoted: a data URI carries unencoded parentheses, which an
              // unquoted `url()` reads as its own closing paren and drops the
              // image entirely.
              backgroundImage: `url("${avatarImageUrl}")`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: `blur(${AVATAR_BLUR_RADIUS * scale}px)`,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `rgba(0, 0, 0, ${AVATAR_SCRIM_OPACITY})`,
            }}
          />
        </>
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
        {chipCount === null ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              paddingTop: MARK_INSET * scale,
              transform: `translateX(${quietMarkOffset * scale}px)`,
            }}
          >
            <AvatarMark
              eyeHeight={DEFAULT_EYE_HEIGHT * scale}
              imageSize={AVATAR_IMAGE_SIZE * scale}
              cornerRadius={AVATAR_IMAGE_CORNER_RADIUS * scale}
              appearance={appearance}
              drawsPhoto={drawsPhotoMark}
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
                drawsPhoto={drawsPhotoMark}
                avatarImageUrl={avatarImageUrl}
                flattened={flattened}
              />
            </div>
            <div style={{ flex: 1 }} />
            <UnreadChip
              count={chipCount}
              scale={scale}
              onSurface={onSurface}
              appearance={appearance}
              flattened={flattened}
            />
          </div>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: CONTROL_GAP * scale }}>
          <WidgetCircleAction
            diameter={CONTROL_DIAMETER * scale}
            fill={controlFill}
            label="Take a photo"
          >
            <CameraGlyph
              size={CONTROL_DIAMETER * scale * 0.4}
              color={onSurface}
            />
          </WidgetCircleAction>
          <WidgetCircleAction
            diameter={CONTROL_DIAMETER * scale}
            fill={controlFill}
            label="New voice conversation"
          >
            <WaveformGlyph
              size={CONTROL_DIAMETER * scale * 0.4}
              color={onSurface}
            />
          </WidgetCircleAction>
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
  drawsPhoto,
  avatarImageUrl,
  flattened,
}: {
  eyeHeight: number;
  imageSize: number;
  cornerRadius: number;
  appearance: WidgetAppearance;
  drawsPhoto: boolean;
  avatarImageUrl: string | null;
  flattened: boolean;
}) {
  if (drawsPhoto && avatarImageUrl !== null) {
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
  appearance,
  flattened,
}: {
  count: number;
  scale: number;
  onSurface: string;
  appearance: WidgetAppearance;
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
      <WidgetUnreadMark
        filled={false}
        size={16 * scale}
        color={onSurface}
        appearance={appearance}
        flattened={flattened}
      />
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
