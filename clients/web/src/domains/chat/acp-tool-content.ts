/**
 * Parses the stringified ACP tool-call `content` into typed display blocks and
 * derives the set of file changes a tool call touched.
 *
 * The daemon JSON-stringifies the ACP `ToolCallContent[]` into the SSE event's
 * `content` field (see assistant/src/acp/client-handler.ts). ACP content blocks
 * come in three variants we render: `content` (text), `diff`
 * (`{ path, newText, oldText? }`), and `terminal`. Parsing is deliberately
 * defensive — malformed, empty, or non-JSON input must never throw, since the
 * content originates off the wire from an external agent.
 */

export type AcpToolContentBlock =
  | { type: "content"; text: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; text?: string };

/**
 * Parse the stringified ACP tool content into typed blocks.
 *
 * Tolerates a single object or an array, mapping only the known variants. A
 * plain non-JSON string falls back to a single `content` block carrying the raw
 * text. Returns `[]` for empty/undefined/malformed input — never throws.
 */
export function parseAcpToolContent(content?: string): AcpToolContentBlock[] {
  if (!content) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Input that looks structurally like JSON (object/array) but fails to parse
    // is malformed wire data → []. Free-form prose is treated as raw text.
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return [];
    return [{ type: "content", text: content }];
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const blocks: AcpToolContentBlock[] = [];

  for (const item of items) {
    const block = parseBlock(item);
    if (block) blocks.push(block);
  }

  return blocks;
}

function parseBlock(item: unknown): AcpToolContentBlock | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;

  switch (obj.type) {
    case "content":
      return { type: "content", text: extractContentText(obj.content) };
    case "diff": {
      if (typeof obj.path !== "string" || typeof obj.newText !== "string") {
        return null;
      }
      return {
        type: "diff",
        path: obj.path,
        newText: obj.newText,
        ...(typeof obj.oldText === "string" ? { oldText: obj.oldText } : {}),
      };
    }
    case "terminal": {
      // The ACP terminal block references a terminal by id and carries no text
      // of its own; surface a `text` field only on the best-effort chance the
      // wire shape includes one rather than discarding it.
      const text = extractTerminalText(obj);
      return text !== undefined ? { type: "terminal", text } : { type: "terminal" };
    }
    default:
      return null;
  }
}

/**
 * The ACP `content` variant nests the text under a `ContentBlock`
 * (`{ content: { type: "text", text } }`). Read that text when present,
 * tolerating a bare string for resilience.
 */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null) {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Best-effort terminal text. The wire shape references a terminal by id and has
 * no text of its own, so this reads a direct `text` field (or a nested
 * `output`/`content` text) when one is present and returns `undefined`
 * otherwise — never fabricating an empty string.
 */
function extractTerminalText(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.content === "object" && obj.content !== null) {
    const text = (obj.content as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

/**
 * Read the agent's command from a tool's `rawInput`, when present. ACP rawInput
 * is optional and its shape is tool-specific, so this is defensive: only a
 * non-null object with a string `command` yields a value; anything else
 * returns `undefined`.
 */
export function getAcpToolCommand(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const command = (rawInput as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/** Join a tool call's `content`/`terminal` text into one string (diffs excluded). */
export function getAcpToolOutputText(content?: string): string {
  return parseAcpToolContent(content)
    .filter((b) => b.type === "content" || b.type === "terminal")
    .map((b) => ("text" in b ? (b.text ?? "") : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Format a raw ACP input/output value for display. `undefined`/`null` → no
 * value; strings pass through verbatim; objects pretty-print as JSON (falling
 * back to `String` when a payload can't serialize, e.g. a circular reference);
 * anything else stringifies. Used to render the expandable Raw input/output
 * section. (Mirrors the inspector's `formatPayload`.)
 */
export function formatRawValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Collect file changes from `diff` blocks, then union in any `locations[].path`
 * not already represented (path-only). Deduped by path; diff entries win over
 * a path-only `locations` entry for the same file.
 */
export function getAcpFileChanges(
  blocks: AcpToolContentBlock[],
  locations?: { path: string; line?: number }[],
): { path: string; oldText?: string; newText?: string }[] {
  const byPath = new Map<string, { path: string; oldText?: string; newText?: string }>();

  for (const block of blocks) {
    if (block.type !== "diff") continue;
    byPath.set(block.path, {
      path: block.path,
      newText: block.newText,
      ...(block.oldText !== undefined ? { oldText: block.oldText } : {}),
    });
  }

  for (const location of locations ?? []) {
    if (!byPath.has(location.path)) {
      byPath.set(location.path, { path: location.path });
    }
  }

  return Array.from(byPath.values());
}
