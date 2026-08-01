import { Capacitor } from "@capacitor/core";

import { isElectron } from "@/runtime/is-electron";
import { shareFileViaMacSheet } from "@/runtime/native-share";

/**
 * Cross-platform file save / share utility.
 *
 * Two *intents* live here as deliberately separate entry points:
 *
 * - **`saveFile` ("Download").** The user asked for the file on their device.
 *   It lands somewhere without further choices: `~/Downloads` on the desktop,
 *   the browser's download location on web. It never presents a share sheet on
 *   a host that can download, because a list of apps to send the file to is not
 *   a saved file.
 * - **`shareFile` ("Share", send elsewhere).** The user asked to hand the file
 *   to another app (Messages, Mail, AirDrop, Slack), so the native Share Sheet
 *   is the point.
 *
 * Per-host behavior:
 *
 * - **Electron (macOS):** `saveFile` uses the standard `<a download>` path
 *   against a blob URL (see the note in `saveFile`); Chromium's download
 *   manager fires `will-download` in the main process, which files the download
 *   into `~/Downloads` (`clients/macos/src/main/downloads.ts`). `shareFile`
 *   presents the native Share Sheet over the `window.vellum.share` bridge,
 *   falling through to a download when the desktop bridge is unavailable
 *   (older preload).
 * - **Capacitor iOS/Android:** the one host where a *download* also goes
 *   through the share sheet. WKWebView does not support the `download`
 *   attribute on anchors with `blob:` URLs (WebKit bug 216918), so the blob is
 *   written to a temp file via `@capacitor/filesystem` and presented via
 *   `@capacitor/share` (`UIActivityViewController`), where "Save to Files" is
 *   the download. That is a platform limitation, not the intent split above.
 * - **Web (plain browser):** the `<a download>` pattern for both intents, since
 *   no reliable cross-browser file-share surface exists to prefer.
 *
 * The Capacitor plugins are lazy-imported so they are never loaded in SSR or
 * plain-browser contexts.
 *
 * References:
 * - WebKit bug: https://bugs.webkit.org/show_bug.cgi?id=216918
 * - Apple UIActivityViewController: https://developer.apple.com/documentation/uikit/uiactivityviewcontroller
 * - @capacitor/filesystem: https://capacitorjs.com/docs/apis/filesystem
 * - @capacitor/share: https://capacitorjs.com/docs/apis/share
 */

/**
 * Download a file to the user's device: the "Download" intent.
 *
 * Never presents the macOS Share Sheet. On Electron this is a real download
 * that the main process files into `~/Downloads`. On Capacitor the iOS share
 * sheet is the only way to hand a blob to the filesystem (see the module
 * docstring), so that host uses the sheet.
 *
 * Accepts either a `Blob` or a URL string.
 */
export async function saveFile(
  source: Blob | string,
  filename: string,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await shareFileNative(source, filename);
    return;
  }
  // Electron: resolve a URL source to a blob before the anchor click. Chromium
  // ignores the `download` attribute on a cross-origin URL and treats the click
  // as a navigation, which the shell's deny-all navigation policy
  // (`clients/macos/src/main/windows.ts`) blocks, so the file never arrives. A
  // blob URL is same-origin, so both the download and the filename survive.
  if (isElectron() && typeof source === "string") {
    try {
      saveFileWeb(await toBlob(source), filename);
      return;
    } catch {
      // Unreachable for same-origin sources. Fall through to the plain anchor
      // rather than dropping the download entirely.
    }
  }
  saveFileWeb(source, filename);
}

/**
 * Share a file with another app: the "Share" intent (Messages, Mail, AirDrop,
 * Slack, Save to Files).
 *
 * Presents the native Share Sheet where one exists (Electron/macOS, Capacitor)
 * and falls back to a plain download on hosts that have none, so the user still
 * ends up with the file.
 *
 * Accepts either a `Blob` or a URL string; a URL is fetched first on the
 * share-sheet paths (see `toBlob`).
 */
export async function shareFile(
  source: Blob | string,
  filename: string,
): Promise<void> {
  // Electron (macOS): native Share Sheet. The blob is resolved lazily so a URL
  // source is only fetched once the desktop bridge is confirmed present;
  // otherwise we fall through to the browser download (older preload).
  if (await shareFileViaMacSheet(() => toBlob(source), filename)) {
    return;
  }
  if (Capacitor.isNativePlatform()) {
    await shareFileNative(source, filename);
    return;
  }
  saveFileWeb(source, filename);
}

/**
 * Resolve a `Blob | string` source to a `Blob`, fetching when given a URL.
 * Shared by the iOS (Capacitor) and Electron share-sheet paths.
 */
async function toBlob(source: Blob | string): Promise<Blob> {
  if (typeof source !== "string") {
    return source;
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }
  return response.blob();
}

async function shareFileNative(
  source: Blob | string,
  filename: string,
): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");

  const base64 = await blobToBase64(await toBlob(source));

  const result = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  try {
    await Share.share({ files: [result.uri] });
  } catch {
    // Share.share() rejects when the user dismisses the Share Sheet
    // without choosing an action. This is expected — not an error.
  }

  // Clean up the temp file. Fire-and-forget — the share sheet copies
  // the file to the user's chosen destination, so the cache copy is
  // no longer needed.
  Filesystem.deleteFile({ path: filename, directory: Directory.Cache }).catch(
    () => {},
  );
}

function saveFileWeb(source: Blob | string, filename: string): void {
  const a = document.createElement("a");

  if (typeof source === "string") {
    a.href = source;
  } else {
    a.href = URL.createObjectURL(source);
  }

  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  if (source instanceof Blob) {
    URL.revokeObjectURL(a.href);
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g. "data:application/pdf;base64,")
      const base64 = result.split(",")[1];
      if (base64) {
        resolve(base64);
      } else {
        reject(new Error("Failed to convert blob to base64"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
