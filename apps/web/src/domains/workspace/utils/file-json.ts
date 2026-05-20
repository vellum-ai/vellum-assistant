/**
 * Shared helpers for rendering JSON file content in the workspace file viewer.
 *
 * Mirrors the surface of `file-markdown.tsx` — a sniff helper (`isJson`) plus a
 * content transform (`prettifyJson`) — so the file viewer can branch on JSON
 * the same way it branches on markdown.
 */

/**
 * Strip media-type parameters (e.g. `;charset=utf-8`) from a mime string,
 * trimming whitespace, so callers can do strict equality against the base type.
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
 * `;charset=utf-8`.
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
