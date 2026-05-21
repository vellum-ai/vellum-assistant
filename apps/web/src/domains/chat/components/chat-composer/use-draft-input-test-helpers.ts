/**
 * Exposes the internal localStorage helpers from useDraftInput for unit
 * testing. These are not part of the public API.
 */

const STORAGE_KEY_PREFIX = "vellum:chatDrafts:";

function storageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}${assistantId}`;
}

export function loadDraftsForTest(assistantId: string): Map<string, string> {
  try {
    const raw = window.localStorage.getItem(storageKey(assistantId));
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map();
  }
}

export function persistDraftsForTest(
  assistantId: string,
  drafts: Map<string, string>,
): void {
  try {
    window.localStorage.setItem(
      storageKey(assistantId),
      JSON.stringify(Object.fromEntries(drafts)),
    );
  } catch {
    // noop
  }
}
