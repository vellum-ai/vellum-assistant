import type { Appearance } from "@stripe/stripe-js";

// The Stripe iframe cannot see the app's self-hosted @font-face, so it loads
// DM Sans from Google Fonts to match the shell around it.
export const STRIPE_FONTS = [
  {
    cssSrc:
      "https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap",
  },
];

export interface StripeAppearanceTokens {
  text: string;
  textSecondary: string;
  placeholder: string;
  surface: string;
  field: string;
  accent: string;
  danger: string;
  dangerText: string;
  icon: string;
}

/**
 * Resolves the design-library custom properties the Stripe Appearance needs.
 * `getComputedStyle` returns the declared value for a custom property, which
 * is a hex string in `tokens.css`; Stripe accepts hex and rgb alike, so the
 * values pass through unchanged.
 */
export function readAppearanceTokens(
  root: Element = document.documentElement,
): StripeAppearanceTokens {
  const styles = getComputedStyle(root);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  const textSecondary = read("--content-tertiary");
  return {
    text: read("--content-emphasised"),
    textSecondary,
    placeholder: read("--content-faint"),
    surface: read("--surface-lift"),
    field: read("--surface-base"),
    accent: read("--system-info-strong"),
    danger: read("--system-negative-strong"),
    dangerText: read("--system-negative-on-weak"),
    icon: textSecondary,
  };
}

const HEX = /^#([\da-f]{3}|[\da-f]{6})$/i;
const RGB_FUNCTION = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

function parseChannels(color: string): number[] | null {
  const hex = HEX.exec(color)?.[1];
  if (hex) {
    const full =
      hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  }
  const fn = RGB_FUNCTION.exec(color);
  if (fn) {
    return fn.slice(1).map(Number);
  }
  return null;
}

/**
 * Re-expresses a token color at the given alpha. Returns the input unchanged
 * when it is not a form we can parse, so an unexpected token still renders.
 */
export function withAlpha(color: string, alpha: number): string {
  const channels = parseChannels(color);
  if (!channels) {
    return color;
  }
  const [r, g, b] = channels;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function appearanceFromTokens(
  tokens: StripeAppearanceTokens,
  base: "stripe" | "night",
): Appearance {
  const focusRing = `0 0 0 3px ${withAlpha(tokens.accent, 0.14)}`;
  return {
    theme: base,
    labels: "floating",
    variables: {
      fontFamily: '"DM Sans", system-ui, sans-serif',
      fontSizeBase: "15px",
      fontSizeSm: "11px",
      fontWeightMedium: "500",
      borderRadius: "12px",
      spacingUnit: "4px",
      spacingGridRow: "10px",
      spacingGridColumn: "10px",
      colorText: tokens.text,
      colorTextSecondary: tokens.textSecondary,
      colorTextPlaceholder: tokens.placeholder,
      colorBackground: tokens.surface,
      colorPrimary: tokens.accent,
      colorDanger: tokens.danger,
      colorIcon: tokens.icon,
      focusOutline: "none",
      focusBoxShadow: focusRing,
    },
    rules: {
      ".Input": {
        backgroundColor: tokens.field,
        border: "1px solid transparent",
        boxShadow: "none",
        padding: "9px 14px",
        transition:
          "background-color 120ms, border-color 120ms, box-shadow 120ms",
      },
      ".Input:focus": {
        backgroundColor: tokens.surface,
        border: `1px solid ${tokens.accent}`,
        boxShadow: focusRing,
      },
      ".Input--invalid": {
        border: `1px solid ${tokens.danger}`,
        boxShadow: "none",
      },
      ".Input::placeholder": {
        color: tokens.placeholder,
      },
      ".Label": {
        fontSize: "11px",
        fontWeight: "500",
        color: tokens.textSecondary,
      },
      ".Label--invalid": {
        color: tokens.danger,
      },
      ".Error": {
        fontSize: "12.5px",
        color: tokens.dangerText,
      },
    },
  };
}

/**
 * Any non-light theme (dark, velvet) uses the `night` base; the token values
 * resolved from the document carry the actual palette.
 */
export function buildStripeAppearance(theme: string): Appearance {
  return appearanceFromTokens(
    readAppearanceTokens(),
    theme === "light" ? "stripe" : "night",
  );
}
