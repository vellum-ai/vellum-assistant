/**
 * Validation for the `visual` ui_show surface: a self-contained HTML fragment
 * rendered inside a sandboxed frame.
 *
 * The frame has no network access and injects a fixed set of design tokens on
 * `:root`, so an external sub-resource silently never loads and a `var()` to
 * anything outside that vocabulary resolves to nothing. Both failures render a
 * blank or unthemed widget with no error anywhere, so they are caught here and
 * reported as teaching errors the model can act on before the surface is ever
 * emitted.
 */

/** Upper bound on fragment size. Well above any well-formed visual. */
const MAX_HTML_CHARS = 48000;

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

const PALETTE_PROPERTIES: readonly string[] = [
  ...NEUTRAL_PALETTES.flatMap((palette) =>
    ["50", ...RAMP_STEPS].map((step) => `--color-${palette}-${step}`),
  ),
  ...ACCENT_PALETTES.flatMap((palette) =>
    RAMP_STEPS.map((step) => `--color-${palette}-${step}`),
  ),
];

/**
 * The CSS custom properties that exist inside a widget frame. The host injects
 * exactly these onto `:root` of the sandboxed iframe.
 *
 * Mirrors `WIDGET_TOKEN_PROPERTIES` in
 * `clients/web/src/utils/widget-tokens.ts` — the two must change together.
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

/** Lookup form of {@link WIDGET_TOKEN_PROPERTIES}. */
const WIDGET_TOKEN_NAMES: ReadonlySet<string> = new Set(
  WIDGET_TOKEN_PROPERTIES,
);

/**
 * Complete vocabulary, quoted back to the model when a fragment references a
 * variable that does not exist. Enumerating every non-palette name (they are
 * short) lets the first retry succeed instead of the model guessing plausible
 * names or re-reading the skill.
 */
const TOKEN_FAMILY_SUMMARY =
  WIDGET_TOKEN_PROPERTIES.filter((name) => !name.startsWith("--color-")).join(
    ", ",
  ) +
  ", and the fixed ramps --color-<moss|stone>-<50-950> and --color-<forest|emerald|danger|amber>-<100-950>";

/**
 * Sub-resource loads the sandbox blocks outright. Catching them here turns a
 * silently blank widget into an actionable error.
 */
const EXTERNAL_RESOURCE_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /<script\b[^>]*\bsrc\s*=/i, what: "a <script src=...> tag" },
  {
    pattern: /<link\b[^>]*\bstylesheet\b/i,
    what: "a <link rel=stylesheet> tag",
  },
  { pattern: /@import\b/i, what: "a CSS @import rule" },
];

/** Every `var(--name)` reference in the fragment. */
const VAR_REFERENCE_PATTERN = /var\(\s*(--[a-zA-Z0-9-]+)/g;

/** Every `--name:` declaration, i.e. properties the fragment defines itself. */
const CUSTOM_PROPERTY_DECLARATION_PATTERN = /(--[a-zA-Z0-9-]+)\s*:/g;

/** Properties the fragment sets from script: `setProperty('--name', …)`. */
const SET_PROPERTY_DECLARATION_PATTERN =
  /setProperty\(\s*["'](--[a-zA-Z0-9-]+)["']/g;

/**
 * Fragments legitimately carry `#`-prefixed identifiers that are not colours:
 * SVG paint and filter references, in-page anchors, and numeric character
 * references. Removing them before the colour scan keeps the check unambiguous.
 */
const NON_COLOR_HASH_PATTERNS: RegExp[] = [
  /url\(\s*['"]?#[^)]*\)/gi,
  /href\s*=\s*["']#[^"']*["']/gi,
  /&#x?[0-9a-fA-F]+;/g,
];

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX_TOKEN_PATTERN = /#([0-9a-fA-F]+)\b/g;
const HEX_COLOR_LENGTHS = new Set([3, 4, 6, 8]);

/** Functional colour notations whose first argument is a literal number. */
const FUNCTIONAL_COLOR_PATTERN =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?:\d|\.\d|-\d)[^)]*\)/gi;

/** How many offending values a teaching error quotes back. */
const MAX_QUOTED_PROBLEMS = 5;

/** Every ramp-token reference, with the palette and stop split out. */
const RAMP_TOKEN_PATTERN = new RegExp(
  `--color-(${[...NEUTRAL_PALETTES, ...ACCENT_PALETTES].join("|")})-(50|${RAMP_STEPS.join("|")})\\b`,
  "g",
);

/**
 * Stops dark enough that text painted with them disappears against the dark
 * theme's background, and light enough to disappear against the light one.
 */
const DARK_RAMP_STOPS: ReadonlySet<string> = new Set([
  "700",
  "800",
  "900",
  "950",
]);
const LIGHT_RAMP_STOPS: ReadonlySet<string> = new Set(["50", "100", "200"]);
/** Fill stops light enough to carry dark ramp text. */
const LIGHT_FILL_STOPS: ReadonlySet<string> = new Set([
  "50",
  "100",
  "200",
  "300",
]);

/** `color:` declarations, excluding `background-color:`, `stop-color:`, etc. */
const TEXT_COLOR_DECLARATION_PATTERN = /(?<![-\w])color\s*:\s*[^;}"'>]*/gi;

/** Open tags of the two SVG elements that paint glyphs. */
const SVG_TEXT_TAG_PATTERN = /<(?:text|tspan)\b[^>]*>/gi;

/**
 * Style rules, used to spot the ones that paint text via `fill:`. The selector
 * is bounded by `<`, `>`, `;` and `}` so it cannot swallow preceding markup.
 */
const CSS_RULE_PATTERN = /[^{};<>]*\{[^{}]*\}/g;
const FILL_DECLARATION_PATTERN = /\bfill\s*:/i;
const FONT_DECLARATION_PATTERN = /\bfont(?:-[a-z]+)?\s*:/i;
const TEXT_SELECTOR_PATTERN = /(?:^|[\s,>+~])(?:text|tspan)\b/i;

type SourceRange = { start: number; end: number };

/**
 * Spans of the fragment that paint text: `color:` declarations, `<text>` and
 * `<tspan>` open tags, and style rules whose `fill:` lands on glyphs — either
 * because the rule also sets a font property or because its selector names a
 * text element. A ramp token inside one of these is a text colour.
 */
function collectTextColorRanges(html: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const match of html.matchAll(TEXT_COLOR_DECLARATION_PATTERN)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  for (const match of html.matchAll(SVG_TEXT_TAG_PATTERN)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  for (const match of html.matchAll(CSS_RULE_PATTERN)) {
    const rule = match[0];
    const selector = rule.slice(0, rule.indexOf("{"));
    if (
      FILL_DECLARATION_PATTERN.test(rule) &&
      (FONT_DECLARATION_PATTERN.test(rule) ||
        TEXT_SELECTOR_PATTERN.test(selector))
    ) {
      const start = match.index ?? 0;
      ranges.push({ start, end: start + rule.length });
    }
  }
  return ranges;
}

function isInsideRange(index: number, ranges: SourceRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/**
 * Ramp stops are theme-invariant, so ramp-coloured text only reads when it sits
 * on a matching ramp fill. Text painted with a dark stop and no light fill of
 * the same palette anywhere in the fragment is sitting on the transparent
 * widget background, where it vanishes in dark mode (and the mirror case
 * vanishes in light mode).
 *
 * The check is deliberately loose about placement: any counterpart fill of the
 * same palette clears the palette, so a correct matched triple never trips it.
 */
function collectRampContrastProblems(html: string): string[] {
  const textRanges = collectTextColorRanges(html);
  const darkText = new Map<string, Set<string>>();
  const lightText = new Map<string, Set<string>>();
  const fillStops = new Map<string, Set<string>>();

  for (const match of html.matchAll(RAMP_TOKEN_PATTERN)) {
    const token = match[0];
    const palette = match[1];
    const stop = match[2];
    if (!isInsideRange(match.index ?? 0, textRanges)) {
      const stops = fillStops.get(palette) ?? new Set<string>();
      stops.add(stop);
      fillStops.set(palette, stops);
      continue;
    }
    const bucket = DARK_RAMP_STOPS.has(stop)
      ? darkText
      : LIGHT_RAMP_STOPS.has(stop)
        ? lightText
        : undefined;
    if (bucket) {
      const tokens = bucket.get(palette) ?? new Set<string>();
      tokens.add(token);
      bucket.set(palette, tokens);
    }
  }

  const hasStopIn = (palette: string, allowed: ReadonlySet<string>): boolean =>
    [...(fillStops.get(palette) ?? [])].some((stop) => allowed.has(stop));

  const problems: string[] = [];
  const unbacked = [...darkText]
    .filter(([palette]) => !hasStopIn(palette, LIGHT_FILL_STOPS))
    .flatMap(([, tokens]) => [...tokens]);
  if (unbacked.length > 0) {
    problems.push(
      `Dark ramp stops used as text colour with no matching light fill: ${quote(unbacked)}. ` +
        "Ramp stops are the same colour in both themes, so dark ramp text on the transparent widget " +
        "background is invisible in dark mode. Put ramp-coloured text only on a matching light ramp " +
        "fill (a 50–300 stop of the same palette), or use a --content-* token for text that sits on " +
        "the page background.",
    );
  }

  const unbackedLight = [...lightText]
    .filter(([palette]) => !hasStopIn(palette, DARK_RAMP_STOPS))
    .flatMap(([, tokens]) => [...tokens]);
  if (unbackedLight.length > 0) {
    problems.push(
      `Light ramp stops used as text colour with no matching dark fill: ${quote(unbackedLight)}. ` +
        "Ramp stops are the same colour in both themes, so light ramp text on the transparent widget " +
        "background is invisible in light mode. Put it on a matching dark ramp fill (a 700–950 stop of " +
        "the same palette), or use a --content-* token for text that sits on the page background.",
    );
  }

  return problems;
}

function collectDeclaredProperties(html: string): Set<string> {
  const declared = new Set<string>();
  for (const match of html.matchAll(CUSTOM_PROPERTY_DECLARATION_PATTERN)) {
    declared.add(match[1]);
  }
  for (const match of html.matchAll(SET_PROPERTY_DECLARATION_PATTERN)) {
    declared.add(match[1]);
  }
  return declared;
}

function collectUnknownVariables(html: string): string[] {
  const declared = collectDeclaredProperties(html);
  const unknown = new Set<string>();
  for (const match of html.matchAll(VAR_REFERENCE_PATTERN)) {
    const name = match[1];
    if (!WIDGET_TOKEN_NAMES.has(name) && !declared.has(name)) {
      unknown.add(name);
    }
  }
  return [...unknown];
}

function collectColorLiterals(html: string): string[] {
  let scannable = html;
  for (const pattern of NON_COLOR_HASH_PATTERNS) {
    scannable = scannable.replace(pattern, " ");
  }

  const literals: string[] = [];
  for (const match of scannable.matchAll(HEX_TOKEN_PATTERN)) {
    if (HEX_COLOR_LENGTHS.has(match[1].length)) {
      literals.push(match[0]);
    }
  }
  for (const match of scannable.matchAll(FUNCTIONAL_COLOR_PATTERN)) {
    literals.push(match[0]);
  }
  return literals;
}

function quote(values: string[]): string {
  const shown = values.slice(0, MAX_QUOTED_PROBLEMS).join(", ");
  const extra = values.length - MAX_QUOTED_PROBLEMS;
  return extra > 0 ? `${shown}, and ${extra} more` : shown;
}

/**
 * Everything wrong with a `visual` fragment, as a list of problems the model
 * can fix in one pass. Empty means the fragment is renderable.
 */
export function validateVisualHtml(html: string): string[] {
  const problems: string[] = [];

  if (html.length > MAX_HTML_CHARS) {
    problems.push(
      `The fragment is ${html.length} characters, over the ${MAX_HTML_CHARS} limit. ` +
        "Simplify it: cut nodes, drop subtitles, remove decorative markup, or split the idea across two visuals with prose between them.",
    );
  }

  for (const { pattern, what } of EXTERNAL_RESOURCE_PATTERNS) {
    if (pattern.test(html)) {
      problems.push(
        `The fragment contains ${what}. The sandbox has no network access, so external resources never load. ` +
          "Inline the styles and draw charts and diagrams by hand in SVG.",
      );
    }
  }

  const unknown = collectUnknownVariables(html);
  if (unknown.length > 0) {
    problems.push(
      `Undefined CSS variables: ${quote(unknown)}. Only the injected design tokens exist inside the ` +
        "frame — every other name resolves to nothing and the declaration is dropped. " +
        `The vocabulary is ${TOKEN_FAMILY_SUMMARY}. ` +
        "To use a variable of your own, declare it in the fragment's own style block first.",
    );
  }

  const literals = collectColorLiterals(html);
  if (literals.length > 0) {
    problems.push(
      `Hardcoded colour values: ${quote(literals)}. Every colour — text, background, border, SVG ` +
        "fill and stroke — comes from an injected variable, so the visual follows the user's theme. " +
        `Replace each literal with a token from ${TOKEN_FAMILY_SUMMARY}.`,
    );
  }

  problems.push(...collectRampContrastProblems(html));

  return problems;
}
