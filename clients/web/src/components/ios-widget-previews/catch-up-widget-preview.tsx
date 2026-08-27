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
 * The Catch Up widget: an action column, and the recent conversations beside
 * it.
 *
 * Medium only, on a 339x161 canvas. Titles and group names are
 * `.privacySensitive()` on the device, so iOS redacts them on a locked phone,
 * which is what makes carrying titles into the snapshot defensible at all.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/CatchUpWidget.swift
 */

import { BubbleGlyph, EllipsisGlyph, WaveformGlyph } from "./widget-glyphs";
import {
  WidgetActionTile,
  WIDGET_TILE_ICON_SIZE,
} from "./widget-action-controls";
import { VellumAppIconMark } from "./vellum-app-icon-mark";
import { WidgetCard } from "./widget-card";
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
const ACTION_COLUMN_WIDTH = 71;
const COLUMN_GAP = 14;
const TILE_GAP = 7;
const HEADER_TOP_INSET = 3;
const HEADER_LEADING_INSET = 4;
const HEADER_BOTTOM_GAP = 5;
const MAX_ROWS = 3;
const ROW_DESIGN_HEIGHT = 37;
const ROW_LEADING_INSET = 8;
const ROW_TEXT_TOP_INSET = 6;
const ROW_GLYPH_SIZE = 12;
const ROW_GLYPH_TEXT_GAP = 7;
/** Where the glyph hangs, by whether the row carries a subtitle. */
const GLYPH_TWO_LINE_TOP_INSET = 12.5;
const GLYPH_TITLE_ONLY_TOP_INSET = 7;
const FLATTENED_TILE_FILL = "rgba(255, 255, 255, 0.12)";

export interface CatchUpConversation {
  id: string;
  title: string;
  /** The group the conversation belongs to; omitted, the row is one line. */
  subtitle?: string;
  hasUnseen?: boolean;
  isProcessing?: boolean;
}

export interface CatchUpWidgetPreviewProps {
  scale?: number;
  appearance?: WidgetAppearance;
  conversations?: CatchUpConversation[];
  /** See `QuickActionsWidgetPreviewProps`. The kind gates the accent; the
   *  raster still rides the New Chat surface whatever the kind. */
  avatarKind?: WidgetAvatarKind;
  accentHex?: string | null;
  avatarImageUrl?: string | null;
  /** A snapshot too old to be trusted about work in flight. */
  isStale?: boolean;
  flattened?: boolean;
}

export function CatchUpWidgetPreview({
  scale = 1,
  appearance = "light",
  conversations = [],
  avatarKind = "character",
  accentHex = "#0E9B8B",
  avatarImageUrl = null,
  isStale = false,
  flattened = false,
}: CatchUpWidgetPreviewProps) {
  const accent = softAccent(themeAccentHex(avatarKind, accentHex));
  const rows = conversations.slice(0, MAX_ROWS);
  const textPrimary = flattened
    ? "#FFFFFF"
    : resolveColor(widgetTheme.textPrimary, appearance);
  const textSecondary = flattened
    ? "rgba(255, 255, 255, 0.6)"
    : resolveColor(widgetTheme.textSecondary, appearance);

  // What the header leaves the rows, so three of them give back the two points
  // the design's own rows overrun the content box by.
  const listHeight =
    161 * scale -
    CONTENT_MARGIN * scale * 2 -
    (HEADER_TOP_INSET + HEADER_BOTTOM_GAP + 12) * scale;
  const rowHeight =
    rows.length === 0
      ? ROW_DESIGN_HEIGHT * scale
      : Math.min(ROW_DESIGN_HEIGHT * scale, listHeight / rows.length);

  return (
    <WidgetCard
      family="medium"
      scale={scale}
      appearance={appearance}
      background={flattened ? FLATTENED_CARD_GROUND : widgetTheme.surface}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: COLUMN_GAP * scale,
          height: "100%",
          padding: CONTENT_MARGIN * scale,
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            width: ACTION_COLUMN_WIDTH * scale,
            display: "flex",
            flexDirection: "column",
            gap: TILE_GAP * scale,
            height: "100%",
          }}
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

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 10 * scale,
              color: textSecondary,
              paddingTop: HEADER_TOP_INSET * scale,
              paddingLeft: HEADER_LEADING_INSET * scale,
              paddingBottom: HEADER_BOTTOM_GAP * scale,
            }}
          >
            Catch up:
          </span>
          {rows.length === 0 ? (
            <span
              style={{
                fontSize: 11 * scale,
                fontWeight: 500,
                color: textSecondary,
                paddingTop: 2 * scale,
                paddingLeft: ROW_LEADING_INSET * scale,
              }}
            >
              Open Vellum to see your recent chats.
            </span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {rows.map((conversation) => (
                <Row
                  key={conversation.id}
                  conversation={conversation}
                  height={rowHeight}
                  scale={scale}
                  appearance={appearance}
                  isStale={isStale}
                  flattened={flattened}
                  textPrimary={textPrimary}
                  textSecondary={textSecondary}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </WidgetCard>
  );
}

function Row({
  conversation,
  height,
  scale,
  appearance,
  isStale,
  flattened,
  textPrimary,
  textSecondary,
}: {
  conversation: CatchUpConversation;
  height: number;
  scale: number;
  appearance: WidgetAppearance;
  isStale: boolean;
  flattened: boolean;
  textPrimary: string;
  textSecondary: string;
}) {
  const subtitle = conversation.subtitle ?? null;
  const glyphTopInset =
    subtitle === null ? GLYPH_TITLE_ONLY_TOP_INSET : GLYPH_TWO_LINE_TOP_INSET;
  // Working beats unread, and staleness beats working.
  const working = conversation.isProcessing === true && !isStale;

  return (
    <div
      style={{
        height,
        display: "flex",
        alignItems: "flex-start",
        gap: ROW_GLYPH_TEXT_GAP * scale,
        paddingLeft: ROW_LEADING_INSET * scale,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          width: ROW_GLYPH_SIZE * scale,
          height: ROW_GLYPH_SIZE * scale,
          marginTop: glyphTopInset * scale,
          position: "relative",
          display: "inline-flex",
          flexShrink: 0,
        }}
      >
        {working ? (
          <EllipsisGlyph size={11 * scale} color={textSecondary} />
        ) : (
          <BubbleGlyph size={11 * scale} color={textPrimary} filled={false} />
        )}
        {!working && conversation.hasUnseen === true ? (
          <span
            style={{
              position: "absolute",
              top: -1 * scale,
              right: -1 * scale,
              width: 4 * scale,
              height: 4 * scale,
              borderRadius: "50%",
              background: flattened
                ? "#FFFFFF"
                : resolveColor(widgetTheme.unseenIndicator, appearance),
            }}
          />
        ) : null}
      </span>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2 * scale,
          paddingTop: ROW_TEXT_TOP_INSET * scale,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: 12 * scale,
            fontWeight: 500,
            color: textPrimary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {conversation.title}
        </span>
        {subtitle !== null ? (
          <span
            style={{
              fontSize: 7 * scale,
              fontWeight: 500,
              color: textSecondary,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </div>
  );
}
