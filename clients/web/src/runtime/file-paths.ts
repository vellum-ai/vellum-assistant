import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for resolving a renderer `File` object to its native
 * filesystem path. Only available in the Electron desktop shell — on web and
 * Capacitor iOS a browser can't expose the underlying path, so this function
 * returns `null` and the caller must fall back to reading the bytes.
 *
 * The main use case is folder drag-drop: a directory dropped into a browser
 * `DataTransferItem` comes back as a zero-byte `File`, but Electron's
 * `webUtils.getPathForFile` resolves it to the real absolute path so the
 * assistant can be pointed at the folder without an upload.
 */
export function getNativePathForFile(file: File): string | null {
  if (!isElectron()) {
    return null;
  }
  return window.vellum?.paths?.getPathForFile(file) ?? null;
}
