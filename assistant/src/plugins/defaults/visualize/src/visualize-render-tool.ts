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

function error(message: string): ToolExecutionResult {
  return { content: message, isError: true };
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
    "Good moments: how something works, how parts relate, how a number moves, what a screen or record looks like.",
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
        note: "The visual is now visible inline in the chat. Continue your response in prose and do not describe or restate what the visual shows.",
      }),
      isError: false,
    };
  },
};
