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
  ...PALETTES.flatMap((palette) =>
    COLOR_RAMP.map((step) => `--color-${palette}-${step}`),
  ),
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
  ", and the fixed ramps --color-<moss|stone|forest|emerald|danger|amber>-<50-950>";

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

  return problems;
}
