/**
 * Helpers for the positional `contentOrder` encoding shared by the canonical
 * wire contract (`ConversationMessage`) and the display layer.
 *
 * Each entry is a `"<type>:<ref>"` string. `<type>` is the content kind
 * (`text`, `thinking`, `tool`/`toolCall`, `surface`, `attachment`) and `<ref>`
 * locates the payload:
 *   - History rows use a positional index into the matching array
 *     (`"text:0"`, `"thinking:1"`, `"tool:0"`).
 *   - Rows still streaming reference a live entity id (`"surface:<surfaceId>"`,
 *     `"toolCall:<toolCallId>"`) because the array index isn't yet stable.
 *
 * Renderers resolve `<ref>` by matching an entity id first and falling back to
 * the positional index, so both producers interoperate.
 */
export interface ContentOrderEntry {
  type: string;
  id: string;
}

/** Encode a `{ type, id }` pair into its `"<type>:<id>"` wire form. */
export function encodeContentOrderEntry(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Parse a `"<type>:<ref>"` entry into its parts, splitting on the first colon
 * so refs that themselves contain colons survive intact. Returns `null` for
 * entries without a leading type segment.
 */
export function parseContentOrderEntry(entry: string): ContentOrderEntry | null {
  const colonIdx = entry.indexOf(":");
  if (colonIdx <= 0) {
    return null;
  }
  return { type: entry.slice(0, colonIdx), id: entry.slice(colonIdx + 1) };
}

/**
 * Sanitize a raw wire `contentOrder` into the display array, dropping anything
 * that isn't a parseable `"<type>:<ref>"` string and returning `undefined` when
 * nothing remains. The input is typed `unknown[]` because the history endpoint
 * only narrows rows by `id`/`role` — `contentOrder` reaches here unvalidated,
 * so legacy/malformed entries (numbers, `null`, objects) must be tolerated.
 */
export function normalizeContentOrder(
  raw: readonly unknown[] | undefined,
): string[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const result = raw.filter(
    (entry): entry is string =>
      typeof entry === "string" && parseContentOrderEntry(entry) !== null,
  );
  return result.length > 0 ? result : undefined;
}
