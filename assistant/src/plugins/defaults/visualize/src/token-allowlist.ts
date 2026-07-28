/**
 * The CSS custom properties that exist inside a widget frame.
 *
 * The host injects exactly these onto `:root` of the sandboxed iframe, so a
 * `var()` reference to anything else resolves to nothing and the declaration is
 * dropped. `visualize_render` validates fragments against this set.
 *
 * Mirrors `WIDGET_TOKEN_PROPERTIES` in
 * `clients/web/src/utils/widget-tokens.ts` — the two must change together.
 */

const COLOR_RAMP = [
  "50",
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

const PALETTES = [
  "moss",
  "stone",
  "forest",
  "emerald",
  "danger",
  "amber",
] as const;

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
  ...PALETTES.flatMap((palette) =>
    COLOR_RAMP.map((step) => `--color-${palette}-${step}`),
  ),
];

/** Lookup form of {@link WIDGET_TOKEN_PROPERTIES}. */
export const WIDGET_TOKEN_NAMES: ReadonlySet<string> = new Set(
  WIDGET_TOKEN_PROPERTIES,
);

/**
 * Complete vocabulary, quoted back to the model when a fragment references a
 * variable that does not exist. Enumerating every non-palette name (they are
 * short) lets the first retry succeed instead of the model guessing plausible
 * names or re-fetching the guide.
 */
export const TOKEN_FAMILY_SUMMARY =
  WIDGET_TOKEN_PROPERTIES.filter((name) => !name.startsWith("--color-")).join(
    ", ",
  ) +
  ", and the fixed ramps --color-<moss|stone|forest|emerald|danger|amber>-<50-950>";
