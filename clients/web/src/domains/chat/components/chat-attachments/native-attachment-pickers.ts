/**
 * Photo-library and document pickers for the Capacitor shells.
 *
 * A hidden `<input type="file">` cannot reach either surface on iOS: WebKit
 * answers every click with its own action sheet (Photo Library / Take Photo /
 * Choose File) unless `capture` forces the camera, which is why the sheet's
 * camera row already lands correctly and the other two do not. These go
 * straight to `PHPickerViewController` and `UIDocumentPickerViewController`
 * instead, so a row opens the surface it names.
 *
 * Both return plain `File`s. Everything downstream of `onAddAttachmentFiles`
 * already accepts `File[]` because drag-and-drop built it that way, so the
 * picked files pick up vision gating, auto-resize and the HEIC-to-JPEG
 * conversion in `attachment-image-resize.ts` on the same path a dropped file
 * takes. That conversion is why the photo library is safe to read natively:
 * WebKit transcodes HEIC for a file input, `PHPicker` hands back the original,
 * and the store converts it either way.
 *
 * Neither picker needs a permission grant. Both run out of process, so iOS
 * shows no prompt and `Info.plist` needs no new usage description.
 */

import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { FilePicker } from "@capawesome/capacitor-file-picker";

/** Filename for a picked photo whose source path carries none. */
function photoFilename(index: number, format: string): string {
  return `photo-${index + 1}.${format || "jpg"}`;
}

/**
 * Reads a native file path into a `File` through the web view's own bridge.
 *
 * `convertFileSrc` maps a native path onto a URL WKWebView can fetch, which
 * streams the bytes. The alternative the plugins offer is base64 in the result
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

/**
 * Opens the system photo library. Resolves empty when the user cancels, so
 * callers treat "picked nothing" and "dismissed" the same way.
 */
export async function pickPhotosNative(): Promise<File[]> {
  const { photos } = await Camera.pickImages({});
  return Promise.all(
    photos.map((photo, index) =>
      fileFromNativePath(
        photo.path ?? photo.webPath,
        photoFilename(index, photo.format),
        `image/${photo.format || "jpeg"}`,
      ),
    ),
  );
}

/** Opens the system document picker. */
export async function pickFilesNative(): Promise<File[]> {
  const { files } = await FilePicker.pickFiles({});
  return Promise.all(
    files.map(async (file) => {
      // The web implementation hands back a Blob directly; the native ones
      // hand back a path. Preferring the Blob keeps this correct if the sheet
      // is ever exercised outside a shell.
      if (file.blob) {
        return new File([file.blob], file.name, { type: file.mimeType });
      }
      return fileFromNativePath(file.path ?? "", file.name, file.mimeType);
    }),
  );
}
