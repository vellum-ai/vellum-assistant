/**
 * Design-token bridge for sandboxed widget iframes.
 *
 * A `srcdoc` iframe rendered without `allow-same-origin` is its own document
 * with no access to the host's stylesheets, so a widget cannot read the app's
 * CSS custom properties. This module snapshots the host's *resolved* token
 * values off `document.documentElement` and emits them as a `:root` block the
 * widget can reference through the same variable names the app uses
 * (`var(--surface-lift)`, `var(--font-sans)`, …).
 *
 * Because the values are resolved at snapshot time, the widget automatically
 * matches whichever theme is active — the caller re-snapshots and remounts the
 * iframe when the host's `data-theme` changes.
 *
 * The semantic tokens flip with the theme on their own. The palette ramps do
 * not: every stop is one constant colour, so a light 100 fill authored for the
 * light reading arrives on a dark canvas as a washed-out pastel sticker. Inside
 * the frame the ramps are therefore made theme-adaptive — under a dark scheme
 * each ramp variable is emitted carrying its mirrored stop's value (see
 * {@link WIDGET_RAMP_DARK_MIRROR}), so a matched triple authored once against
 * the light reading (light fill, mid border, dark text) renders natively as a
 * soft dark tint with light text.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Window/getComputedStyle
 */

const RAMP_STEPS = [
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
] as const;

/** Neutral ramps carry an extra lightest step; the accents start at 100. */
const NEUTRAL_PALETTES = ["moss", "stone"] as const;
const ACCENT_PALETTES = ["forest", "emerald", "danger", "amber"] as const;

const NEUTRAL_RAMP_STEPS: readonly string[] = ["50", ...RAMP_STEPS];

const PALETTE_PROPERTIES: readonly string[] = [
  ...NEUTRAL_PALETTES.flatMap((palette) =>
    NEUTRAL_RAMP_STEPS.map((step) => `--color-${palette}-${step}`),
  ),
  ...ACCENT_PALETTES.flatMap((palette) =>
    RAMP_STEPS.map((step) => `--color-${palette}-${step}`),
  ),
];

/**
 * For each ramp variable, the variable whose value it carries under a dark
 * scheme: the stop reflected through the middle of its own ramp. Ramps are
 * paired within themselves, so the mapping is symmetric — reading it in either
 * direction gives the same table.
 *
 * The accents run 100–950 (10 stops), pairing 100/950, 200/900, 300/800,
 * 400/700 and 500/600. The neutrals carry an extra 50 (11 stops), pairing
 * 50/950, 100/900, 200/800, 300/700, 400/600 and leaving 500 on itself.
 */
export const WIDGET_RAMP_DARK_MIRROR: ReadonlyMap<string, string> = new Map(
  [
    ...NEUTRAL_PALETTES.map(
      (palette) => [palette, NEUTRAL_RAMP_STEPS] as const,
    ),
    ...ACCENT_PALETTES.map(
      (palette) => [palette, RAMP_STEPS as readonly string[]] as const,
    ),
  ].flatMap(([palette, steps]) =>
    steps.map((step, index) => [
      `--color-${palette}-${step}`,
      `--color-${palette}-${steps[steps.length - 1 - index]}`,
    ]),
  ),
);

/**
 * The custom properties exposed to widgets. Deliberately an allowlist rather
 * than a sweep of every declared property: the widget contract is a stable,
 * documented token vocabulary, and app-internal layout variables
 * (`--chat-max-width`, `--avatar-accent`, …) are not part of it.
 *
 * Mirrored by `WIDGET_TOKEN_PROPERTIES` in
 * `assistant/src/tools/ui-surface/visual-validation.ts`, which rejects a
 * visual referencing a variable outside this list — the two must change
 * together.
 */
export const WIDGET_TOKEN_PROPERTIES: readonly string[] = [
  // Surfaces
  "--surface-base",
  "--surface-lift",
  "--surface-overlay",
  "--surface-active",
  "--surface-hover",
  "--surface-sunken",
  // Content
  "--content-default",
  "--content-emphasised",
  "--content-secondary",
  "--content-tertiary",
  "--content-quiet",
  "--content-strong",
  "--content-faint",
  "--content-disabled",
  "--content-inset",
  // Borders
  "--border-base",
  "--border-subtle",
  "--border-element",
  "--border-hover",
  "--border-disabled",
  "--border-active",
  // System / status
  "--system-positive-strong",
  "--system-positive-weak",
  "--system-negative-strong",
  "--system-negative-weak",
  "--system-negative-hover",
  "--system-mid-strong",
  "--system-mid-weak",
  "--system-info-strong",
  "--system-info-weak",
  // Fonts
  "--font-sans",
  "--font-mono",
  "--font-serif",
  // Radius
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--radius-xxl",
  "--radius-pill",
  // Palettes
  ...PALETTE_PROPERTIES,
];

/**
 * Base document styles every widget inherits: a transparent page so the host
 * transcript's background shows through, zero margin so the auto-height
 * reporter measures content rather than chrome, and the app's own type
 * defaults.
 */
const WIDGET_BASE_STYLES =
  "html{margin:0}" +
  "body{margin:0;padding:6px 10px;background:transparent;color:var(--content-default);" +
  "font-family:var(--font-sans);font-size:16px;line-height:1.6}" +
  "*,*::before,*::after{box-sizing:border-box}";

/**
 * Strip characters that would let a token value terminate the declaration or
 * escape the `<style>` element. Token values come from the app's own
 * stylesheet, so this is belt-and-braces rather than a live threat — but the
 * snapshot is serialized into untrusted-adjacent HTML, so it is sanitized on
 * the way out.
 */
function sanitizeTokenValue(value: string): string {
  return value.replace(/[<>{};\\]/g, "").trim();
}

/**
 * Read the resolved values of {@link WIDGET_TOKEN_PROPERTIES} off `root`
 * (defaulting to the document element). Properties that resolve to an empty
 * string — a palette step a theme doesn't define, say — are omitted.
 *
 * Under the dark scheme each ramp variable is emitted carrying its mirrored
 * stop's value; semantic tokens are read as declared in both schemes.
 */
export function readWidgetTokens(
  root?: Element | null,
  colorScheme: "light" | "dark" = "light",
): Record<string, string> {
  const element =
    root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!element) {
    return {};
  }
  const computed = getComputedStyle(element);
  const tokens: Record<string, string> = {};
  for (const property of WIDGET_TOKEN_PROPERTIES) {
    const source =
      colorScheme === "dark"
        ? WIDGET_RAMP_DARK_MIRROR.get(property) ?? property
        : property;
    const value = sanitizeTokenValue(computed.getPropertyValue(source));
    if (value) {
      tokens[property] = value;
    }
  }
  return tokens;
}

/**
 * The `color-scheme` a widget declares. Every theme but `light` is a dark
 * family (velvet included), and the declaration is what makes the iframe's
 * scrollbars, form controls and default canvas match the host.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme
 */
export function colorSchemeForTheme(theme: string): "light" | "dark" {
  return theme === "light" ? "light" : "dark";
}

/** Serialize a token snapshot into the `<style>` block prepended to a widget. */
export function buildWidgetStyleTag(
  tokens: Record<string, string>,
  colorScheme: "light" | "dark",
): string {
  const declarations = Object.entries(tokens)
    .map(([property, value]) => `${property}:${value};`)
    .join("");
  return `<style>:root{color-scheme:${colorScheme};${declarations}}${WIDGET_BASE_STYLES}</style>`;
}

/** A token snapshot serialized for injection, plus whether it carries values. */
export interface WidgetStyleSnapshot {
  /** The `<style>` block to prepend to the widget document. */
  style: string;
  /**
   * Whether the host resolved any token. `false` means the document carried no
   * values at read time — the app's stylesheet had not applied yet — so the
   * style block declares only `color-scheme` and every `var(--…)` inside the
   * widget would resolve to its guaranteed-invalid fallback. Callers must
   * re-read rather than bake an unresolved snapshot into a widget.
   */
  resolved: boolean;
}

/** Snapshot the host's tokens for `theme` and serialize them in one step. */
export function buildWidgetStyle(
  theme: string,
  root?: Element | null,
): WidgetStyleSnapshot {
  const colorScheme = colorSchemeForTheme(theme);
  const tokens = readWidgetTokens(root, colorScheme);
  return {
    style: buildWidgetStyleTag(tokens, colorScheme),
    resolved: Object.keys(tokens).length > 0,
  };
}
