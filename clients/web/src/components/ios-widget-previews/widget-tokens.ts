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
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetTheme.swift
 */

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

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function darken(hex: string, factor: number): string {
  const { r, g, b } = parseHex(hex);
  return toHex({ r: r * factor, g: g * factor, b: b * factor });
}

function blend(base: string, overlay: string, alpha: number): string {
  const a = parseHex(base);
  const b = parseHex(overlay);
  return toHex({
    r: a.r + (b.r - a.r) * alpha,
    g: a.g + (b.g - a.g) * alpha,
    b: a.b + (b.b - a.b) * alpha,
  });
}

/**
 * Relative luminance, the input to `UIColor.contrastingForeground`'s choice of
 * a foreground that survives the card it is drawn on. A yellow avatar and a
 * deep green one both have to produce a legible card, which a fixed white
 * cannot.
 */
function isLight(hex: string): boolean {
  const { r, g, b } = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

/** `WidgetAvatarPalette`: the colors a card painted with an accent draws from. */
export interface WidgetAvatarPalette {
  surface: WidgetAppearanceColor;
  onSurface: WidgetAppearanceColor;
  /** `controlFill(onWhite:onDark:)`, as an rgba string per appearance. */
  controlFill: (onWhite: number, onDark: number) => WidgetAppearanceColor;
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function avatarPalette(accentHex: string | null): WidgetAvatarPalette {
  if (accentHex === null) {
    return {
      surface: widgetTheme.brandCardSurface,
      onSurface: widgetTheme.onBrand,
      controlFill: (onWhite) => ({
        light: withAlpha("#FFFFFF", onWhite),
        dark: withAlpha("#FFFFFF", onWhite),
      }),
    };
  }
  const light = accentHex;
  const dark = darken(accentHex, DARK_SURFACE_FACTOR);
  const lightOn = isLight(light) ? "#111417" : "#FFFFFF";
  const darkOn = isLight(dark) ? "#111417" : "#FFFFFF";
  return {
    surface: { light, dark },
    onSurface: { light: lightOn, dark: darkOn },
    controlFill: (onWhite, onDark) => ({
      light: withAlpha(lightOn, isLight(lightOn) ? onWhite : onDark),
      dark: withAlpha(darkOn, isLight(darkOn) ? onWhite : onDark),
    }),
  };
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
      light: blend(
        widgetTheme.surface.light,
        accentHex,
        SOFT_ACCENT_LIGHT_WASH,
      ),
      dark: blend(widgetTheme.surface.dark, accentHex, SOFT_ACCENT_DARK_WASH),
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
