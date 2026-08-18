/**
 * Photo-library and document pickers for the Capacitor shells.
 *
 * A hidden `<input type="file">` cannot reach either surface on iOS: WebKit
 * answers every click with its own action sheet (Photo Library / Take Photo /
 * Choose File) unless `capture` forces the camera, which is why the sheet's
 * camera row already lands correctly and the other two do not. These go
 * straight to the system media and document pickers instead, so a row opens
 * the surface it names.
 *
 * Both return plain `File`s. Everything downstream of `onAddAttachmentFiles`
 * already accepts `File[]` because drag-and-drop built it that way, so the
 * picked files pick up vision gating, auto-resize and the HEIC-to-JPEG
 * conversion in `attachment-image-resize.ts` on the same path a dropped file
 * takes. That conversion is why the photo library is safe to read natively:
 * WebKit transcodes HEIC for a file input, the native picker hands back the
 * original, and the store converts it either way.
 *
 * Neither picker needs a permission grant. Both run out of process, so iOS
 * shows no prompt and `Info.plist` needs no new usage description.
 */

import { Capacitor } from "@capacitor/core";

import { isNativeMobile } from "@/runtime/platform-detection";

/** Registered name of the native plugin backing both pickers. */
const FILE_PICKER_PLUGIN = "FilePicker";

/**
 * Whether this shell can actually reach the native pickers.
 *
 * The shells load the web app from a remote `server.url`, so a bundle
 * carrying these call sites reaches installed builds that predate the plugin
 * being linked. There the calls reject as unimplemented, and a row wired
 * straight to them would do nothing at all until the user updated the app.
 * `isPluginAvailable` reads what the native runtime actually registered, so
 * an older shell falls back to the file input and keeps the behaviour it
 * shipped with.
 */
export function nativeAttachmentPickersAvailable(): boolean {
  return isNativeMobile() && Capacitor.isPluginAvailable(FILE_PICKER_PLUGIN);
}

/**
 * Whether a rejection is the user dismissing the picker rather than a failure.
 *
 * The plugin reports a dismissal by rejecting with a message ending
 * `canceled.` on both the native and web implementations, and carries no error
 * code to key off instead. Matching the word is therefore the only signal
 * available; it is matched loosely so either spelling counts, and anything
 * that does not match is treated as a real failure rather than swallowed.
 */
export function isPickerDismissal(error: unknown): boolean {
  return error instanceof Error && /cancell?ed/i.test(error.message);
}

/**
 * Reads a native file path into a `File` through the web view's own bridge.
 *
 * `convertFileSrc` maps a native path onto a URL WKWebView can fetch, which
 * streams the bytes. The alternative the plugin offers is base64 in the result
 * payload, which materialises the whole file in JS memory: fine for a photo,
 * not for the video a photo library will happily hand over.
 */
async function fileFromNativePath(
  path: string,
  name: string,
  mimeType: string,
): Promise<File> {
  const response = await fetch(Capacitor.convertFileSrc(path));
  const blob = await response.blob();
  return new File([blob], name, { type: mimeType || blob.type });
}

interface PickedFile {
  blob?: Blob;
  path?: string;
  name: string;
  mimeType: string;
}

async function toFiles(picked: PickedFile[]): Promise<File[]> {
  return Promise.all(
    picked.map(async (file) => {
      // The web implementation hands back a Blob directly; the native ones
      // hand back a path.
      if (file.blob) {
        return new File([file.blob], file.name, { type: file.mimeType });
      }
      return fileFromNativePath(file.path ?? "", file.name, file.mimeType);
    }),
  );
}

/**
 * Opens the system media picker, for images and video alike. `pickMedia`
 * rather than an images-only call: the file input this replaces accepted
 * `image/*,video/*`, and a row that silently dropped video would be a
 * narrower Photo Library than the one it replaces.
 */
export async function pickMediaNative(): Promise<File[]> {
  // Destructured inline, never held at module scope or returned from an async
  // function: a plugin is a Proxy that synthesizes `.then`, so letting one
  // reach a Promise-resolution context dispatches `then()` natively and hangs
  // the await for good. See `docs/CAPACITOR.md`.
  const { FilePicker } = await import("@capawesome/capacitor-file-picker");
  const { files } = await FilePicker.pickMedia();
  return toFiles(files);
}

/** Opens the system document picker. */
export async function pickFilesNative(): Promise<File[]> {
  const { FilePicker } = await import("@capawesome/capacitor-file-picker");
  const { files } = await FilePicker.pickFiles();
  return toFiles(files);
}
