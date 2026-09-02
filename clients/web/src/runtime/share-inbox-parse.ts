/**
 * Pure parser for a consumed share-inbox item. Lives in its own module
 * so tests can import it without loading the Capacitor plugin bridge
 * (and without colliding with process-global `mock.module` stubs of
 * `@/runtime/share-inbox`).
 */

export type ShareInboxDestination =
  | { type: "new" }
  | { type: "thread"; threadId: string };

export interface ShareInboxFileRef {
  name: string;
  mimeType: string;
  path: string;
}

export interface ShareInboxItem {
  id: string;
  destination: ShareInboxDestination;
  text: string | null;
  files: ShareInboxFileRef[];
}

export function parseShareInboxItem(raw: unknown): ShareInboxItem | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  const destination = parseDestination(value.destination);
  if (destination === null) {
    return null;
  }
  const text =
    typeof value.text === "string" && value.text.trim().length > 0
      ? value.text
      : null;
  const files = Array.isArray(value.files)
    ? value.files.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") {
          return [];
        }
        const file = entry as Record<string, unknown>;
        if (
          typeof file.name !== "string" ||
          file.name.length === 0 ||
          typeof file.path !== "string" ||
          file.path.length === 0
        ) {
          return [];
        }
        return [
          {
            name: file.name,
            mimeType:
              typeof file.mimeType === "string" && file.mimeType.length > 0
                ? file.mimeType
                : "application/octet-stream",
            path: file.path,
          },
        ];
      })
    : [];
  if (text === null && files.length === 0) {
    return null;
  }
  return { id: value.id, destination, text, files };
}

function parseDestination(raw: unknown): ShareInboxDestination | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.type === "new") {
    return { type: "new" };
  }
  if (
    value.type === "thread" &&
    typeof value.threadId === "string" &&
    value.threadId.length > 0
  ) {
    return { type: "thread", threadId: value.threadId };
  }
  return null;
}
