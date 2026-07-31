import { Capacitor } from "@capacitor/core";

import { shareFileViaMacSheet } from "@/runtime/native-share";

/**
 * Cross-platform file save/share utility.
 *
 * - **Electron (macOS):** presents the native macOS Share Sheet
 *   (`NSSharingServicePicker`) via the `window.vellum.share` bridge — the
 *   desktop counterpart to the iOS sheet (Messages, Mail, AirDrop, Slack,
 *   Save to Files, …). Falls through to the browser download if the desktop
 *   bridge is unavailable.
 * - **Capacitor iOS:** the standard web pattern (`<a download>` with a blob
 *   URL) is broken — WKWebView does not support the `download` attribute on
 *   anchors with `blob:` URLs (WebKit bug 216918). Instead the blob is written
 *   to a temp file via `@capacitor/filesystem` and presented via
 *   `@capacitor/share`, which wraps `UIActivityViewController`.
 * - **Web (plain browser):** the `<a download>` pattern.
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
 * Save or share a file. On Electron (macOS) and Capacitor iOS, presents the
 * native Share Sheet; on plain web, triggers a browser download.
 *
 * Accepts either a `Blob` or a URL string; a URL is fetched first on the
 * share-sheet paths (see `toBlob`).
 */
export async function saveFile(
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
    await saveFileNative(source, filename);
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

async function saveFileNative(
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
