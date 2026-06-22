import type { Surface } from "@/domains/chat/types/types";

export type InlineSegment =
  | { type: "text"; content: string }
  | { type: "surface"; surface: Surface };

const UI_SHOW_RE = /<ui_show\s*([^>]*)>([\s\S]*?)<\/ui_show>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

let counter = 0;

/**
 * Parses `<ui_show>` tags embedded in assistant text and returns an array of
 * text and surface segments. Returns `null` when no tags are found so callers
 * can skip the overhead.
 */
export function parseInlineSurfaces(text: string): InlineSegment[] | null {
  UI_SHOW_RE.lastIndex = 0;

  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = UI_SHOW_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }

    const attrString = match[1];
    const jsonBody = match[2].trim();

    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((attrMatch = ATTR_RE.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    let templateData: Record<string, unknown> = {};
    try {
      templateData = JSON.parse(jsonBody) as Record<string, unknown>;
    } catch {
      // Malformed JSON — skip this tag, emit it as text
      segments.push({ type: "text", content: match[0] });
      lastIndex = UI_SHOW_RE.lastIndex;
      continue;
    }

    const surfaceType = attrs.surface_type ?? "card";
    const template = attrs.template;
    const title = (templateData.title as string | undefined) ?? attrs.title;

    const surface: Surface = {
      surfaceId: `inline-surface-${++counter}`,
      surfaceType,
      title,
      data: {
        ...(template ? { template } : {}),
        templateData,
      },
    };

    segments.push({ type: "surface", surface });
    lastIndex = UI_SHOW_RE.lastIndex;
  }

  if (segments.length === 0) {
    return null;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments;
}
