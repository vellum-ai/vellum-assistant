import { Capacitor } from "@capacitor/core";

/**
 * Cross-platform file save/share utility.
 *
 * On Capacitor iOS, the standard web pattern (`<a download>` with a blob URL)
 * is broken — WKWebView does not support the `download` attribute on anchors
 * with `blob:` URLs (WebKit bug 216918). Instead, this module writes the blob
 * to a temporary file via `@capacitor/filesystem` and presents the native iOS
 * Share Sheet via `@capacitor/share`, which wraps `UIActivityViewController`.
 * The Share Sheet gives the user "Save to Files", AirDrop, Mail, Messages,
 * and every other system sharing target — the standard iOS UX for exporting
 * content from an app.
 *
 * On web (non-Capacitor), the existing `<a download>` pattern is used.
 *
 * Both plugins are lazy-imported so they are never loaded in SSR or
 * plain-browser contexts.
 *
 * References:
 * - WebKit bug: https://bugs.webkit.org/show_bug.cgi?id=216918
 * - Apple UIActivityViewController: https://developer.apple.com/documentation/uikit/uiactivityviewcontroller
 * - @capacitor/filesystem: https://capacitorjs.com/docs/apis/filesystem
 * - @capacitor/share: https://capacitorjs.com/docs/apis/share
 */

/**
 * Save or share a file. On iOS, presents the native Share Sheet. On web,
 * triggers a browser download via the `<a download>` pattern.
 *
 * Accepts either a `Blob` or a URL string. When a URL is provided on iOS,
 * the file is fetched first, then written to a temp location for sharing.
 */
export async function saveFile(
  source: Blob | string,
  filename: string,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await saveFileNative(source, filename);
  } else {
    saveFileWeb(source, filename);
  }
}

async function saveFileNative(
  source: Blob | string,
  filename: string,
): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");

  let blob: Blob;
  if (typeof source === "string") {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }
    blob = await response.blob();
  } else {
    blob = source;
  }

  const base64 = await blobToBase64(blob);

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
