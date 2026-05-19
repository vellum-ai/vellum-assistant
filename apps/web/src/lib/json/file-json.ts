/**
 * Shared helpers for rendering JSON FILE content (as opposed to JSON in API
 * responses or chat messages).
 *
 * Used by:
 *   - WorkspaceFileViewer (workspace tab, viewing files in the assistant's home dir)
 *
 * Mirrors the surface of `file-markdown.ts` — a sniff helper (`isJson`) plus a
 * content transform (`prettifyJson`) — so the file viewer can branch on JSON
 * the same way it branches on markdown.
 */

/**
 * Strip any media-type parameters (e.g. `;charset=utf-8`) from a mime string,
 * trimming whitespace, so callers can do strict equality against the base type.
 *
 * Returns `""` for an empty or missing mime so equality checks fail safely.
 */
function baseMediaType(mimeType: string | undefined): string {
  if (!mimeType) return "";
  const semi = mimeType.indexOf(";");
  return (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim();
}

/**
 * True if the file looks like JSON by name or mime type.
 *
 * Recognised extensions: `.json`.
 * Recognised mime: `application/json` — with or without parameters such as
 * `;charset=utf-8`, which servers commonly attach and which previously caused
 * JSON files to fall through to the binary-file placeholder.
 *
 * Deliberately scoped tight: jsonl/ndjson are line-delimited streams, not
 * single JSON documents, and would mis-render under a pretty-printer. Add
 * separate handling if/when needed.
 */
export function isJson(
  name: string | undefined,
  mimeType: string | undefined,
): boolean {
  if (baseMediaType(mimeType) === "application/json") return true;
  const lower = (name ?? "").toLowerCase();
  return lower.endsWith(".json");
}

/**
 * Pretty-print JSON content with 2-space indentation.
 *
 * Falls back to the raw content unchanged if it doesn't parse — partial saves,
 * trailing-comma files, and hand-edited config files should still be viewable
 * rather than disappearing behind an error state.
 */
export function prettifyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
