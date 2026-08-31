/**
 * The Home Screen widgets' palette and design geometry, transcribed from the
 * Swift that actually draws them.
 *
 * These are not app design tokens and must not be used by app code. A widget
 * renders in an extension process that never runs this SPA, so it cannot read
 * the CSS custom properties the product themes itself with; its palette is a
 * set of literals in `WidgetTheme.swift`. This module mirrors those literals so
 * the previews in this directory are worth looking at, and every value below
 * names the Swift declaration it was copied from.
 *
 * Source of truth is the Swift, always. When the two disagree the Swift is
 * right and this file is stale.
 *
 * Only the literals are transcribed. The derivations come from
 * `@/utils/avatar-tone`, which the Swift names as its own source of truth:
 * `UIColor.contrastingForeground` mirrors that file's `contrastForeground`,
 * and `blendHex` / `darkenHex` mirror its namesakes.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetTheme.swift
 * @see clients/ios/App/App/Shared/CSSHexColor.swift
 */

import { blendHex, contrastForeground, darkenHex } from "@/utils/avatar-tone";

/** A color that resolves from the appearance the widget is rendered in. */
export interface WidgetAppearanceColor {
  light: string;
  dark: string;
}

export type WidgetAppearance = "light" | "dark";

export function resolveColor(
  color: WidgetAppearanceColor,
  appearance: WidgetAppearance,
): string {
  return color[appearance];
}

/** `WidgetTheme` in `WidgetTheme.swift`. */
export const widgetTheme = {
  surface: { light: "#FFFFFF", dark: "#1C1C1E" },
  newChatFill: { light: "#E6F5F3", dark: "#123832" },
  voiceFill: { light: "#F6F5F4", dark: "#2C2C2E" },
  brand: { light: "#0E9B8B", dark: "#2FC1AE" },
  textPrimary: { light: "#111417", dark: "#F2F2F7" },
  textSecondary: { light: "#7C8894", dark: "#98A2AE" },
  unseenIndicator: { light: "#FFB200", dark: "#FFC13D" },
  brandCardSurface: { light: "#0E9B8B", dark: "#0B7A6E" },
  /** Fixed in both appearances: the card under it is deep green either way. */
  onBrand: { light: "#FFFFFF", dark: "#FFFFFF" },
  /** Fixed: a face does not change color with the Home Screen behind it. */
  avatarSclera: { light: "#F2F2F2", dark: "#F2F2F2" },
  avatarPupil: { light: "#1A1A1A", dark: "#1A1A1A" },
} satisfies Record<string, WidgetAppearanceColor>;

/**
 * `WidgetAvatarPalette.darkSurfaceFactor`: how far an accent is deepened for
 * dark appearance, so a saturated card is not the brightest thing on a dark
 * Home Screen.
 */
const DARK_SURFACE_FACTOR = 0.79;

/** `WidgetSoftAccent`'s two washes: the accent's share of the card. */
const SOFT_ACCENT_LIGHT_WASH = 0.105;
const SOFT_ACCENT_DARK_WASH = 0.22;

/**
 * `avatar-tone.ts`'s `FG_DARK`, the darker of the two answers
 * `contrastForeground` gives. Named here so the fill weighting below can tell
 * which one it was handed.
 */
const FG_DARK = "#1A1A1A";

function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (m === null) {
    return hex;
  }
  const n = Number.parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

/** `WidgetAvatarPalette`: the colors a card painted with an accent draws from. */
export interface WidgetAvatarPalette {
  surface: WidgetAppearanceColor;
  onSurface: WidgetAppearanceColor;
  /** `controlFill(onWhite:onDark:)`, as an rgba string per appearance. */
  controlFill: (onWhite: number, onDark: number) => WidgetAppearanceColor;
}

export function avatarPalette(accentHex: string | null): WidgetAvatarPalette {
  if (accentHex === null) {
    return {
      surface: widgetTheme.brandCardSurface,
      onSurface: widgetTheme.onBrand,
      // The brand card is a deep green in both appearances, so what sits on it
      // is white in both, and a white wash is what lifts it.
      controlFill: (onWhite) => ({
        light: withAlpha("#FFFFFF", onWhite),
        dark: withAlpha("#FFFFFF", onWhite),
      }),
    };
  }
  const light = accentHex;
  const dark = darkenHex(accentHex, DARK_SURFACE_FACTOR);
  const lightOn = contrastForeground(light);
  const darkOn = contrastForeground(dark);
  return {
    surface: { light, dark },
    onSurface: { light: lightOn, dark: darkOn },
    // `weighted(_:onWhite:onDark:)`: a white wash lifts a dark card further
    // than a black wash deepens a light one, so the two weights differ and the
    // foreground's own brightness picks between them.
    controlFill: (onWhite, onDark) => ({
      light: withAlpha(lightOn, lightOn === FG_DARK ? onDark : onWhite),
      dark: withAlpha(darkOn, darkOn === FG_DARK ? onDark : onWhite),
    }),
  };
}

/**
 * `WidgetAvatarKind`: what a widget can do with the snapshot's avatar, as the
 * three treatments it has rather than as the string the payload carries.
 *
 * The discriminator is the kind, never the presence of a raster: a character
 * payload carries its accent AND its encoded face together, so "has an image"
 * says nothing about which treatment the card wants.
 */
export type WidgetAvatarKind = "character" | "image" | "none";

/**
 * `SnapshotEntry.themeAccentHex`: the accent a rendering themes itself with,
 * or `null` to keep the static tokens.
 *
 * The one owner of the rule that only a character avatar carries an accent: an
 * uploaded photo has none by design, an account with nothing synced has none to
 * read, and any other kind keeps the static palette even if a malformed or
 * newer-schema payload carries an accent alongside it. Both palettes below read
 * the gate from here, so a card and the controls on it cannot disagree about
 * which accounts are themed.
 */
export function themeAccentHex(
  kind: WidgetAvatarKind,
  accentHex: string | null,
): string | null {
  return kind === "character" ? accentHex : null;
}

/** `WidgetSoftAccent`: the pale card a New Chat surface sits on. */
export interface WidgetSoftAccent {
  fill: WidgetAppearanceColor;
  onFill: WidgetAppearanceColor;
}

export function softAccent(accentHex: string | null): WidgetSoftAccent {
  if (accentHex === null) {
    return { fill: widgetTheme.newChatFill, onFill: widgetTheme.brand };
  }
  return {
    fill: {
      light: blendHex(
        widgetTheme.surface.light,
        accentHex,
        SOFT_ACCENT_LIGHT_WASH,
      ),
      dark: blendHex(
        widgetTheme.surface.dark,
        accentHex,
        SOFT_ACCENT_DARK_WASH,
      ),
    },
    onFill: widgetTheme.textPrimary,
  };
}

/**
 * The canvases each widget's measurements are designed on, so a preview can
 * scale the way the real card does: every dimension is multiplied by the ratio
 * between the rendered size and the design size.
 */
export const WIDGET_DESIGN_SIZE = {
  small: { width: 160, height: 161 },
  medium: { width: 339, height: 161 },
} as const;

/**
 * The ground a flattened card is composited over. The system supplies its own
 * material on a themed Home Screen; this stands in for it so the
 * translucent-white control fills have something to read against.
 */
export const FLATTENED_CARD_GROUND = "rgba(30, 30, 32, 1)";

/**
 * The system draws a widget's corner, not the widget. Approximated here so the
 * preview reads as a Home Screen tile rather than as a rectangle.
 */
export const WIDGET_CORNER_RADIUS = 24;

/**
 * SwiftUI's `.system(size:)` is SF Pro. Off an Apple platform the stack falls
 * through to whatever the browser has, so metrics drift from the device; see
 * the fidelity note in the stories.
 */
export const WIDGET_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif';
