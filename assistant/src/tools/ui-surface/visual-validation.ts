/**
 * Validation for the `visual` ui_show surface: a self-contained HTML fragment
 * rendered inside a sandboxed frame.
 *
 * The frame has no network access and injects a fixed vocabulary of design
 * tokens on `:root`, so an external sub-resource silently never loads and a
 * `var()` to
 * anything outside that vocabulary resolves to nothing. Both failures render a
 * blank or unthemed widget with no error anywhere, so they are caught here and
 * reported as teaching errors the model can act on before the surface is ever
 * emitted.
 */

/**
 * Upper bound on fragment size. Sized to what one model response can emit
 * with room to spare: a fragment past this cannot be produced in a single
 * ui_show call, so the turn burns its output budget and renders nothing.
 */
const MAX_HTML_CHARS = 24000;

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
  "--system-positive-on-weak",
  "--system-negative-strong",
  "--system-negative-weak",
  "--system-negative-on-weak",
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
  ", and the palette ramps --color-<moss|stone>-<50-950> and --color-<forest|emerald|danger|amber>-<100-950>";

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

/** Every root `<svg …>` open tag. Nested `<svg>` is not a thing we author. */
const SVG_OPEN_TAG_PATTERN = /<svg\b[^>]*>/gi;

const VIEWBOX_ATTRIBUTE_PATTERN = /\bviewBox\s*=/i;

/** A `width`/`height` attribute whose value is a bare or `px` pixel count. */
const SVG_PIXEL_SIZE_PATTERN =
  /\b(width|height)\s*=\s*["'](\d+(?:\.\d+)?)(px)?["']/gi;

/**
 * Widest an `<svg>` can be sized in pixels before it overruns the frame. The
 * container gives a visual about 660px of usable width, and the drawing
 * conventions lay out against a 680-unit canvas; anything past that is only
 * safe as a viewBox, which scales.
 */
const MAX_SVG_PIXEL_SIZE = 680;

/**
 * The fix for an unscalable `<svg>`, quoted verbatim so the retry lands in one
 * call rather than guessing at a smaller pixel width.
 */
const VIEWBOX_FIX =
  'Give the root svg a viewBox="0 0 W H" (W and H are the drawing\'s own coordinate extent, W 680 by convention) plus width="100%", and remove any fixed pixel width and height. ' +
  "A viewBox is what makes a drawing scale to whatever width the frame has; a pixel-sized svg keeps its size and is silently clipped at the right edge, with no scrollbar and nothing on screen to say content is missing.";

/** `<rect>` open tags, the one shape whose extent is exact from its attributes. */
const SVG_RECT_TAG_PATTERN = /<rect\b[^>]*>/gi;

/** Numbers of a `viewBox="minX minY width height"` value. */
const VIEWBOX_VALUE_PATTERN =
  /\bviewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

/** Sub-pixel slack, so a rounded coordinate is not reported as an overrun. */
const VIEWBOX_BOUNDS_TOLERANCE = 0.5;

function numericAttribute(tag: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["'](-?[\\d.]+)`, "i").exec(tag);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Shapes drawn outside their own `viewBox`. An SVG clips at the viewBox edge,
 * so a node placed past it is not laid out badly, it is invisible. What a
 * reader sees is a diagram whose last box is sliced off, with nothing to
 * indicate more was drawn.
 */
function collectViewBoxOverrunProblems(html: string): string[] {
  const overruns = new Set<string>();

  for (const svg of html.matchAll(SVG_OPEN_TAG_PATTERN)) {
    const box = VIEWBOX_VALUE_PATTERN.exec(svg[0]);
    if (!box) {
      continue;
    }
    const minX = Number(box[1]);
    const minY = Number(box[2]);
    const maxX = minX + Number(box[3]);
    const maxY = minY + Number(box[4]);

    const bodyStart = (svg.index ?? 0) + svg[0].length;
    const closeIndex = html.indexOf("</svg", bodyStart);
    const body = html.slice(
      bodyStart,
      closeIndex === -1 ? html.length : closeIndex,
    );

    for (const rect of body.matchAll(SVG_RECT_TAG_PATTERN)) {
      const x = numericAttribute(rect[0], "x") ?? 0;
      const y = numericAttribute(rect[0], "y") ?? 0;
      const width = numericAttribute(rect[0], "width");
      const height = numericAttribute(rect[0], "height");
      if (width !== undefined && x + width > maxX + VIEWBOX_BOUNDS_TOLERANCE) {
        overruns.add(
          `x=${x} width=${width} ends at ${x + width}, past ${maxX}`,
        );
      }
      if (
        height !== undefined &&
        y + height > maxY + VIEWBOX_BOUNDS_TOLERANCE
      ) {
        overruns.add(
          `y=${y} height=${height} ends at ${y + height}, past ${maxY}`,
        );
      }
    }
  }

  if (overruns.size === 0) {
    return [];
  }
  return [
    `Shapes drawn outside the viewBox: ${quote([...overruns])}. ` +
      "An SVG clips at its viewBox edge, so these render sliced off or not at all, with nothing on screen to say " +
      "content is missing. Either move the shapes back inside the box or widen the viewBox to cover them, " +
      "and re-check the packing math: everything has to fit between the viewBox bounds, gaps included.",
  ];
}

/**
 * `transform` attributes anywhere in the fragment. The layout system is built
 * on absolute viewBox coordinates (grid slots, extent checks, label centring),
 * and a translated group invites mixing local and absolute coordinates on its
 * children — the classic symptom is every label rendering below or beside its
 * box. Banning the attribute keeps one coordinate system for everything.
 */
function collectTransformProblems(html: string): string[] {
  const count = [...html.matchAll(/\stransform\s*=\s*["']/g)].length;
  if (count === 0) {
    return [];
  }
  return [
    `${count} element(s) carry a transform attribute. Every coordinate in the fragment is an absolute viewBox coordinate; ` +
      "remove each transform and place the element directly. A node's text centres at the rect's own position: " +
      'x = rect x + width/2 with text-anchor="middle", y = rect y + 22 for a single line (or +20 and +38 for a two-line node). ' +
      "Translated groups mix local and absolute coordinates and put labels outside their boxes.",
  ];
}

/**
 * Style rules that paint a surface token as an inheritable fill. `fill`
 * inherits from a group to its text children, so `.note{fill:var(--surface-sunken)}`
 * declared after the text classes silently repaints every label in the tile's
 * own background colour. A surface fill is legitimate only when the rule is
 * scoped to shape elements.
 */
const SHAPE_SCOPED_SELECTOR_PATTERN =
  /\b(?:rect|path|circle|ellipse|line|polyline|polygon)\b/;

function collectSurfaceFillOnTextProblems(html: string): string[] {
  const offenders: string[] = [];
  for (const rule of html.matchAll(/([^{}<>]{1,120})\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    const body = rule[2];
    if (!/fill\s*:\s*var\(--surface-/.test(body)) {
      continue;
    }
    if (SHAPE_SCOPED_SELECTOR_PATTERN.test(selector)) {
      continue;
    }
    offenders.push(selector);
  }
  if (offenders.length === 0) {
    return [];
  }
  return [
    `Style rule(s) ${quote(offenders)} set fill to a surface token without scoping to a shape. ` +
      "fill inherits to text, so a group-level surface fill repaints the labels inside it in the background colour " +
      "and they disappear. Scope background fills to the shape (`.note rect{fill:var(--surface-sunken)}`) and keep " +
      "text fills on content tokens or ramp stops.",
  ];
}

/**
 * Problems with how an `<svg>` is sized. Without a `viewBox` the drawing has no
 * intrinsic coordinate system to scale, so it renders at its literal size and
 * the frame crops whatever does not fit.
 */
function collectSvgSizingProblems(html: string): string[] {
  const problems: string[] = [];
  const oversized: string[] = [];
  let missingViewBox = false;

  for (const match of html.matchAll(SVG_OPEN_TAG_PATTERN)) {
    const tag = match[0];
    if (VIEWBOX_ATTRIBUTE_PATTERN.test(tag)) {
      continue;
    }
    missingViewBox = true;
    for (const size of tag.matchAll(SVG_PIXEL_SIZE_PATTERN)) {
      if (Number(size[2]) > MAX_SVG_PIXEL_SIZE) {
        oversized.push(`${size[1]}="${size[2]}${size[3] ?? ""}"`);
      }
    }
  }

  if (missingViewBox) {
    problems.push(`An <svg> element has no viewBox attribute. ${VIEWBOX_FIX}`);
  }
  if (oversized.length > 0) {
    problems.push(
      `An <svg> without a viewBox is sized past the ${MAX_SVG_PIXEL_SIZE}px the frame can show: ${quote(
        oversized,
      )}. Everything beyond that width is cropped away. ${VIEWBOX_FIX}`,
    );
  }

  return problems;
}

/** Every ramp-token reference, with the palette and stop split out. */
const RAMP_TOKEN_PATTERN = new RegExp(
  `--color-(${[...NEUTRAL_PALETTES, ...ACCENT_PALETTES].join(
    "|",
  )})-(50|${RAMP_STEPS.join("|")})\\b`,
  "g",
);

/**
 * The two ends of a ramp, the stops that only read against a fill from the
 * opposite end. The host mirrors ramp stops under the dark scheme, so an end
 * stop swaps sides with the theme while the page background it might be
 * painted on does not — pairing is what keeps the relationship intact.
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

/** Any element's open tag, the span that carries one element's own paint. */
const START_TAG_PATTERN = /<[a-zA-Z][^>]*>/g;

/** `<g>` open and close tags, used to bound the group around a label. */
const GROUP_BOUNDARY_PATTERN = /<g\b[^>]*>|<\/g\s*>/gi;

/** Class names an element carries, used to reach the rules that paint it. */
const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Style rules, used to spot the ones that paint text via `fill:`. The selector
 * is bounded by `<`, `>`, `;` and `}` so it cannot swallow preceding markup.
 */
const CSS_RULE_PATTERN = /[^{};<>]*\{[^{}]*\}/g;
const FILL_DECLARATION_PATTERN = /\bfill\s*:/i;
const FONT_DECLARATION_PATTERN = /\bfont(?:-[a-z]+)?\s*:/i;
const TEXT_SELECTOR_PATTERN = /(?:^|[\s,>+~])(?:text|tspan)\b/i;

/**
 * How much markup either side of a painted label counts as "beside it". A
 * two-line SVG node — rect plus title plus subtitle — runs about 350
 * characters, so this reaches the shape a label belongs to without reaching the
 * rest of the drawing.
 */
const LOCAL_PAIRING_WINDOW = 400;

/**
 * Largest `<g>` that still reads as one paired shape. Past this a group is a
 * layout container, and treating it as a pairing context would clear a palette
 * for the whole drawing.
 */
const MAX_LOCAL_GROUP_CHARS = 2000;

type SourceRange = { start: number; end: number };

type CssRule = SourceRange & { selector: string; body: string };

/** Every `{…}` rule in the fragment, split into selector and body. */
function collectCssRules(html: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const match of html.matchAll(CSS_RULE_PATTERN)) {
    const text = match[0];
    const start = match.index ?? 0;
    const braceIndex = text.indexOf("{");
    rules.push({
      start,
      end: start + text.length,
      selector: text.slice(0, braceIndex),
      body: text.slice(braceIndex),
    });
  }
  return rules;
}

function collectRanges(html: string, pattern: RegExp): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const match of html.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

/** Spans of balanced `<g>…</g>` pairs. Unclosed groups are ignored. */
function collectGroupRanges(html: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const open: number[] = [];
  for (const match of html.matchAll(GROUP_BOUNDARY_PATTERN)) {
    const index = match.index ?? 0;
    if (match[0].startsWith("</")) {
      const start = open.pop();
      if (start !== undefined) {
        ranges.push({ start, end: index + match[0].length });
      }
    } else if (!match[0].endsWith("/>")) {
      open.push(index);
    }
  }
  return ranges;
}

/**
 * Spans of the fragment that paint text: `color:` declarations, `<text>` and
 * `<tspan>` open tags, and style rules whose `fill:` lands on glyphs — either
 * because the rule also sets a font property or because its selector names a
 * text element. A ramp token inside one of these is a text colour.
 */
function collectTextColorRanges(html: string, rules: CssRule[]): SourceRange[] {
  const ranges = [
    ...collectRanges(html, TEXT_COLOR_DECLARATION_PATTERN),
    ...collectRanges(html, SVG_TEXT_TAG_PATTERN),
  ];
  for (const rule of rules) {
    if (
      FILL_DECLARATION_PATTERN.test(rule.body) &&
      (FONT_DECLARATION_PATTERN.test(rule.body) ||
        TEXT_SELECTOR_PATTERN.test(rule.selector))
    ) {
      ranges.push({ start: rule.start, end: rule.end });
    }
  }
  return ranges;
}

function isInsideRange(index: number, ranges: SourceRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/** The tightest range containing the index, if any. */
function innermostRange<T extends SourceRange>(
  index: number,
  ranges: T[],
): T | undefined {
  let found: T | undefined;
  for (const range of ranges) {
    if (index < range.start || index >= range.end) {
      continue;
    }
    if (!found || range.end - range.start < found.end - found.start) {
      found = range;
    }
  }
  return found;
}

/** Whether a stop of `palette` from `allowed` is painted anywhere in `text`. */
function hasCounterpartStop(
  text: string,
  palette: string,
  allowed: ReadonlySet<string>,
): boolean {
  for (const match of text.matchAll(RAMP_TOKEN_PATTERN)) {
    if (match[1] === palette && allowed.has(match[2])) {
      return true;
    }
  }
  return false;
}

/**
 * The markup a directly painted label is paired against: its own open tag, the
 * window of markup around it, the group immediately containing it, and the
 * bodies of the rules that paint the classes named in that window.
 */
function localPairingContexts(
  html: string,
  index: number,
  rules: CssRule[],
  tags: SourceRange[],
  groups: SourceRange[],
): string[] {
  const nearby = html.slice(
    Math.max(0, index - LOCAL_PAIRING_WINDOW),
    index + LOCAL_PAIRING_WINDOW,
  );
  const contexts = [nearby];

  const tag = innermostRange(index, tags);
  if (tag) {
    contexts.push(html.slice(tag.start, tag.end));
  }

  const group = innermostRange(index, groups);
  if (group && group.end - group.start <= MAX_LOCAL_GROUP_CHARS) {
    contexts.push(html.slice(group.start, group.end));
  }

  const classNames = new Set<string>();
  for (const match of nearby.matchAll(CLASS_ATTRIBUTE_PATTERN)) {
    for (const name of (match[1] ?? match[2] ?? "").split(/\s+/)) {
      if (name) {
        classNames.add(name);
      }
    }
  }
  for (const rule of rules) {
    if ([...classNames].some((name) => rule.selector.includes(`.${name}`))) {
      contexts.push(rule.body);
    }
  }

  return contexts;
}

/**
 * The host mirrors each ramp stop onto its opposite under the dark scheme, so a
 * ramp is theme-adaptive only relative to itself: a matched fill and text pair
 * inverts together and stays legible, while a lone ramp label is left against
 * the page background, which takes no part in that mirror. Ramp-coloured text
 * therefore only reads when it sits on a matching ramp fill — and the fill has
 * to be the one actually behind the glyphs.
 *
 * Pairing is therefore local. A label painted directly — an inline `style`, a
 * `fill` attribute on `<text>` — pairs against its own element, the markup
 * around it, the group containing it, or the rules painting the classes in that
 * window. A label painted through a style rule pairs inside that rule, and
 * otherwise against the fragment as a whole: which elements a selector reaches
 * is not knowable without a DOM, so the rule's own placement carries no signal.
 */
function collectRampContrastProblems(html: string): string[] {
  const rules = collectCssRules(html);
  const textRanges = collectTextColorRanges(html, rules);
  const tags = collectRanges(html, START_TAG_PATTERN);
  const groups = collectGroupRanges(html);

  const occurrences = [...html.matchAll(RAMP_TOKEN_PATTERN)].map((match) => ({
    token: match[0],
    palette: match[1],
    stop: match[2],
    index: match.index ?? 0,
  }));

  const fillStops = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    if (isInsideRange(occurrence.index, textRanges)) {
      continue;
    }
    const stops = fillStops.get(occurrence.palette) ?? new Set<string>();
    stops.add(occurrence.stop);
    fillStops.set(occurrence.palette, stops);
  }

  const hasFillStopIn = (
    palette: string,
    allowed: ReadonlySet<string>,
  ): boolean =>
    [...(fillStops.get(palette) ?? [])].some((stop) => allowed.has(stop));

  const unpairedDark = new Set<string>();
  const unpairedLight = new Set<string>();

  for (const occurrence of occurrences) {
    if (!isInsideRange(occurrence.index, textRanges)) {
      continue;
    }
    const bucket = DARK_RAMP_STOPS.has(occurrence.stop)
      ? unpairedDark
      : LIGHT_RAMP_STOPS.has(occurrence.stop)
        ? unpairedLight
        : undefined;
    if (!bucket) {
      continue;
    }
    const counterparts =
      bucket === unpairedDark ? LIGHT_FILL_STOPS : DARK_RAMP_STOPS;

    const rule = innermostRange(occurrence.index, rules);
    const paired = rule
      ? hasCounterpartStop(rule.body, occurrence.palette, counterparts) ||
        hasFillStopIn(occurrence.palette, counterparts)
      : localPairingContexts(html, occurrence.index, rules, tags, groups).some(
          (context) =>
            hasCounterpartStop(context, occurrence.palette, counterparts),
        );

    if (!paired) {
      bucket.add(occurrence.token);
    }
  }

  const problems: string[] = [];
  if (unpairedDark.size > 0) {
    problems.push(
      `Dark ramp stops used as text colour with no matching light fill behind them: ${quote(
        [...unpairedDark],
      )}. ` +
        "Ramp stops mirror across their own ramp in dark mode, so a dark stop used as text flips to a " +
        "light tint there while the page background takes no part in that mirror — a ramp-coloured " +
        "label sitting on it has no reliable contrast in either theme. Ramp-coloured text has to sit " +
        "on a matching light ramp " +
        "fill (a 50–300 stop of the same palette) set on the same element, in the same style rule, or " +
        "on the group immediately around it — or use a --content-* token for text that sits on the " +
        "page background.",
    );
  }
  if (unpairedLight.size > 0) {
    problems.push(
      `Light ramp stops used as text colour with no matching dark fill behind them: ${quote(
        [...unpairedLight],
      )}. ` +
        "Light ramp text on the transparent widget background is invisible in light mode, and in dark " +
        "mode the stop mirrors to the darkest end of its own ramp — invisible there too. " +
        "Ramp-coloured text has to sit on a matching dark ramp " +
        "fill (a 700–950 stop of the same palette) set on the same element, in the same style rule, or " +
        "on the group immediately around it — or use a --content-* token for text that sits on the " +
        "page background.",
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
        "A fragment this size cannot be emitted in one call. Simplify it: cut nodes, drop subtitles, remove decorative markup, or split the idea across two visuals with prose between them.",
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
      `Undefined CSS variables: ${quote(
        unknown,
      )}. Only the injected design tokens exist inside the ` +
        "frame — every other name resolves to nothing and the declaration is dropped. " +
        `The vocabulary is ${TOKEN_FAMILY_SUMMARY}. ` +
        "To use a variable of your own, declare it in the fragment's own style block first.",
    );
  }

  const literals = collectColorLiterals(html);
  if (literals.length > 0) {
    problems.push(
      `Hardcoded colour values: ${quote(
        literals,
      )}. Every colour — text, background, border, SVG ` +
        "fill and stroke — comes from an injected variable, so the visual follows the user's theme. " +
        `Replace each literal with a token from ${TOKEN_FAMILY_SUMMARY}.`,
    );
  }

  problems.push(...collectSvgSizingProblems(html));
  problems.push(...collectViewBoxOverrunProblems(html));
  problems.push(...collectRampContrastProblems(html));
  problems.push(...collectTransformProblems(html));
  problems.push(...collectSurfaceFillOnTextProblems(html));

  return problems;
}
