/**
 * `visualize_render` — pushes a self-contained HTML fragment to the client as
 * an inline `visual` surface.
 *
 * The surface is emitted through `ToolContext.sendToClient`, which the
 * conversation's tool-context wrapper also records against the turn, giving
 * persistence, history replay, and inline positioning without a bespoke
 * transport. Validation failures return teaching errors so the model can
 * repair the fragment on its next attempt rather than re-emitting the same
 * broken markup.
 */

import {
  RiskLevel,
  type Tool,
  type ToolContext,
  type ToolExecutionResult,
} from "@vellumai/plugin-api";

import { TOKEN_FAMILY_SUMMARY, WIDGET_TOKEN_NAMES } from "./token-allowlist.js";

/** Upper bound on fragment size. Well above any well-formed visual. */
const MAX_HTML_CHARS = 48000;

/** Bounds for the caller's initial height estimate, in CSS pixels. */
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;

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

function error(message: string): ToolExecutionResult {
  return { content: message, isError: true };
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
 * Deterministic check that the fragment styles itself from the injected token
 * vocabulary. Both problems are reported together so one retry fixes them all.
 */
function collectTokenProblems(html: string): string[] {
  const problems: string[] = [];

  const unknown = collectUnknownVariables(html);
  if (unknown.length > 0) {
    problems.push(
      `Undefined CSS variables: ${quote(unknown)}. Only the variables listed by visualize_guide ` +
        `exist inside the frame — every other name resolves to nothing and the declaration is dropped. ` +
        `The families are ${TOKEN_FAMILY_SUMMARY}. ` +
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

function normalizeHeight(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(raw)));
}

function normalizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const visualizeRenderTool: Tool = {
  name: "visualize_render",
  description: [
    "Renders a polished visual inline in the chat, right where you are writing.",
    "Use PROACTIVELY whenever an explanation lands better with a diagram, a comparison, a small chart, or an interactive explainer — do not wait for the user to ask for a visual.",
    "Call visualize_guide first (once per conversation) and follow the design system it returns; html must be a self-contained fragment with no external resources.",
    "Colors ONLY via the CSS variables from visualize_guide; hex/rgb/hsl literals and invented variable names are rejected.",
    "Good moments: how something works, how parts relate, how a number moves, what a screen or record looks like.",
    "Quick what-ifs belong here too — a couple of sliders or toggles recomputing inline beats building an app; reserve the app-builder workflow for durable multi-view tools the user will reopen.",
    "Keep prose in your reply, not in the fragment — after this returns, continue writing and do not describe what the visual shows.",
    "One visual per call; call again with prose in between for a second one.",
    "Only graphical clients can display it; on a text-only channel this fails and you answer in prose instead.",
  ].join("\n"),
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "sandbox",
  category: "plugin",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Optional short label for the visual, in sentence case. Omit when the surrounding prose already names it.",
      },
      html: {
        type: "string",
        description:
          "The self-contained HTML or SVG fragment to render. No DOCTYPE, html, head, or body element, and no external resources.",
      },
      height: {
        type: "number",
        description:
          "Estimated rendered height in pixels. The client measures the real height afterwards; this only avoids a jump on first paint.",
      },
    },
    required: ["html"],
    additionalProperties: false,
  },
  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const html = input.html;
    if (typeof html !== "string" || html.trim().length === 0) {
      return error(
        "visualize_render needs a non-empty html fragment. Pass the full markup for the visual in the html argument.",
      );
    }
    if (html.length > MAX_HTML_CHARS) {
      return error(
        `The html fragment is ${html.length} characters, over the ${MAX_HTML_CHARS} limit. ` +
          "Simplify it: cut nodes, drop subtitles, remove decorative markup, or split the idea across two visuals with prose between them.",
      );
    }
    for (const { pattern, what } of EXTERNAL_RESOURCE_PATTERNS) {
      if (pattern.test(html)) {
        return error(
          `The html fragment contains ${what}. The sandbox has no network access, so external resources never load. ` +
            "Inline the styles and draw charts and diagrams by hand in SVG.",
        );
      }
    }

    const tokenProblems = collectTokenProblems(html);
    if (tokenProblems.length > 0) {
      return error(
        "The html fragment does not style itself from the injected design tokens:\n" +
          tokenProblems.map((problem) => `- ${problem}`).join("\n") +
          "\nFix every item above and call visualize_render again.",
      );
    }

    const sendToClient = context.sendToClient;
    if (!sendToClient || context.supportsDynamicUi === false) {
      return error(
        "This conversation cannot display inline visuals. Answer in prose instead — describe the structure in words, or use a markdown table.",
      );
    }

    const surfaceId = crypto.randomUUID();
    const height = normalizeHeight(input.height);
    const title = normalizeTitle(input.title);

    sendToClient({
      type: "ui_surface_show",
      conversationId: context.conversationId,
      surfaceId,
      surfaceType: "visual",
      ...(title ? { title } : {}),
      data: { html, ...(height !== undefined ? { height } : {}) },
      display: "inline",
    });

    return {
      content: JSON.stringify({
        surfaceId,
        status: "rendered",
        note: "The visual is now visible inline in the chat. Continue your response in prose and do not describe or restate what the visual shows. To replace it, call ui_dismiss with this surfaceId and render again.",
      }),
      isError: false,
    };
  },
};
