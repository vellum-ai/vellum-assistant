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
 * The Status widget, in the two states it has: what is waiting when something
 * is, and the ways in when nothing is.
 *
 * A count is worth a small widget's card only while there is a count, so the
 * card flips to a launcher rather than printing "All caught up." over two
 * buttons. Both states sit on the same margins and the same two bands.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/StatusWidget.swift
 */

import { EllipsisGlyph, CameraGlyph, WaveformGlyph } from "./widget-glyphs";
import {
  WidgetActionTile,
  WidgetCircleAction,
  WIDGET_TILE_ICON_SIZE,
} from "./widget-action-controls";
import { VellumAppIconMark } from "./vellum-app-icon-mark";
import { WidgetCard } from "./widget-card";
import { WidgetUnreadMark } from "./widget-unread-mark";
import {
  FLATTENED_CARD_GROUND,
  resolveColor,
  softAccent,
  themeAccentHex,
  widgetTheme,
  type WidgetAppearance,
  type WidgetAvatarKind,
} from "./widget-tokens";

const CONTENT_MARGIN = 16;
const CONTROL_HEIGHT = 61;
const BAND_GAP = 7;
const CIRCLE_GAP = 6;
const TILE_GAP = 8;
const COUNT_GAP = 16;
const GLYPH_COLUMN_WIDTH = 17;
const COUNT_GLYPH_GAP = 7;
const COUNT_TEXT_SIZE = 14;
const FLATTENED_TILE_FILL = "rgba(255, 255, 255, 0.12)";
const FLATTENED_CIRCLE_FILL = "rgba(255, 255, 255, 0.14)";
const FLATTENED_PILL_FILL = "rgba(255, 255, 255, 0.12)";

export interface StatusWidgetPreviewProps {
  scale?: number;
  appearance?: WidgetAppearance;
  unreadCount?: number;
  inProgressCount?: number;
  /** See `QuickActionsWidgetPreviewProps`. The kind gates the accent; the
   *  raster still rides the New Chat surface whatever the kind. */
  avatarKind?: WidgetAvatarKind;
  accentHex?: string | null;
  avatarImageUrl?: string | null;
  /**
   * Whether the snapshot is too old to read as a status. A lone "2 unread" also
   * asserts that nothing is running, which an aged snapshot cannot know, so the
   * card falls back to the launcher rather than apologizing for its counts.
   */
  isStale?: boolean;
  flattened?: boolean;
}

export function StatusWidgetPreview({
  scale = 1,
  appearance = "light",
  unreadCount = 0,
  inProgressCount = 0,
  avatarKind = "character",
  accentHex = "#0E9B8B",
  avatarImageUrl = null,
  isStale = false,
  flattened = false,
}: StatusWidgetPreviewProps) {
  const accent = softAccent(themeAccentHex(avatarKind, accentHex));
  // `StatusWidgetView.isActive`: a stale snapshot has nothing to report.
  const isActive = !isStale && (unreadCount > 0 || inProgressCount > 0);
  const control = CONTROL_HEIGHT * scale;
  const textPrimary = flattened
    ? "#FFFFFF"
    : resolveColor(widgetTheme.textPrimary, appearance);

  return (
    <WidgetCard
      family="small"
      scale={scale}
      appearance={appearance}
      background={flattened ? FLATTENED_CARD_GROUND : widgetTheme.surface}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: CONTENT_MARGIN * scale,
          boxSizing: "border-box",
        }}
      >
        {isActive ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: COUNT_GAP * scale,
              alignItems: "flex-start",
            }}
          >
            {unreadCount > 0 ? (
              <CountLine
                scale={scale}
                text={`${unreadCount} unread`}
                color={textPrimary}
                glyph={
                  <WidgetUnreadMark
                    filled={false}
                    size={16 * scale}
                    color={textPrimary}
                    appearance={appearance}
                    flattened={flattened}
                  />
                }
              />
            ) : null}
            {inProgressCount > 0 ? (
              <CountLine
                scale={scale}
                text={`${inProgressCount} in progress`}
                color={textPrimary}
                glyph={
                  <EllipsisGlyph
                    size={16 * scale}
                    color={
                      flattened
                        ? "rgba(255, 255, 255, 0.6)"
                        : resolveColor(widgetTheme.textSecondary, appearance)
                    }
                  />
                }
              />
            ) : null}
          </div>
        ) : (
          <div style={{ display: "flex", gap: CIRCLE_GAP * scale }}>
            <WidgetCircleAction
              diameter={control}
              fill={
                flattened
                  ? FLATTENED_CIRCLE_FILL
                  : resolveColor(widgetTheme.voiceFill, appearance)
              }
              label="Take a photo"
            >
              <CameraGlyph size={control * 0.4} color={textPrimary} />
            </WidgetCircleAction>
            <WidgetCircleAction
              diameter={control}
              fill={
                flattened
                  ? FLATTENED_CIRCLE_FILL
                  : resolveColor(widgetTheme.voiceFill, appearance)
              }
              label="New voice conversation"
            >
              <WaveformGlyph size={control * 0.4} color={textPrimary} />
            </WidgetCircleAction>
          </div>
        )}
        <div style={{ flex: 1, minHeight: BAND_GAP * scale }} />
        {isActive ? (
          <div
            style={{ display: "flex", gap: TILE_GAP * scale, height: control }}
          >
            <WidgetActionTile
              scale={scale}
              label="New Chat"
              fill={
                flattened
                  ? FLATTENED_TILE_FILL
                  : resolveColor(accent.fill, appearance)
              }
              labelColor={textPrimary}
              icon={
                avatarImageUrl !== null ? (
                  <img
                    src={avatarImageUrl}
                    alt=""
                    style={{
                      width: WIDGET_TILE_ICON_SIZE * scale,
                      height: WIDGET_TILE_ICON_SIZE * scale,
                      borderRadius: "50%",
                      objectFit: "cover",
                      filter: flattened
                        ? "grayscale(1) brightness(1.4)"
                        : undefined,
                    }}
                  />
                ) : (
                  <VellumAppIconMark
                    size={WIDGET_TILE_ICON_SIZE * scale}
                    flattened={flattened}
                  />
                )
              }
            />
            <WidgetActionTile
              scale={scale}
              label="Voice"
              fill={
                flattened
                  ? FLATTENED_TILE_FILL
                  : resolveColor(widgetTheme.voiceFill, appearance)
              }
              labelColor={textPrimary}
              icon={
                <WaveformGlyph
                  size={WIDGET_TILE_ICON_SIZE * scale}
                  color={textPrimary}
                />
              }
            />
          </div>
        ) : (
          <ChatPill
            scale={scale}
            height={control}
            fill={
              flattened
                ? FLATTENED_PILL_FILL
                : resolveColor(accent.fill, appearance)
            }
            tint={
              flattened ? "#FFFFFF" : resolveColor(accent.onFill, appearance)
            }
            avatarImageUrl={avatarImageUrl}
            flattened={flattened}
          />
        )}
      </div>
    </WidgetCard>
  );
}

function CountLine({
  scale,
  text,
  color,
  glyph,
}: {
  scale: number;
  text: string;
  color: string;
  glyph: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: COUNT_GLYPH_GAP * scale,
        width: "100%",
      }}
    >
      <span
        style={{
          width: GLYPH_COLUMN_WIDTH * scale,
          display: "inline-flex",
          justifyContent: "flex-start",
        }}
      >
        {glyph}
      </span>
      <span
        style={{
          fontSize: COUNT_TEXT_SIZE * scale,
          fontWeight: 500,
          color,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </span>
    </div>
  );
}

function ChatPill({
  scale,
  height,
  fill,
  tint,
  avatarImageUrl,
  flattened,
}: {
  scale: number;
  height: number;
  fill: string;
  tint: string;
  avatarImageUrl: string | null;
  flattened: boolean;
}) {
  const iconSize = height * 0.4;
  return (
    <div
      style={{
        height,
        borderRadius: height / 2,
        background: fill,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6 * scale,
        color: tint,
      }}
    >
      {avatarImageUrl !== null ? (
        <img
          src={avatarImageUrl}
          alt=""
          style={{
            width: iconSize,
            height: iconSize,
            borderRadius: "50%",
            objectFit: "cover",
            filter: flattened ? "grayscale(1) brightness(1.4)" : undefined,
          }}
        />
      ) : (
        <VellumAppIconMark size={iconSize} flattened={flattened} />
      )}
      <span style={{ fontSize: 15 * scale, fontWeight: 600 }}>Chat</span>
    </div>
  );
}
