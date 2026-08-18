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

import {
  IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES,
  isAutoResizableImage,
} from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import { MAX_ATTACHMENT_BYTES } from "@/domains/chat/composer-store";
import { isNativeMobile } from "@/runtime/platform-detection";

/** Picked files that could be read, plus the names of any refused as too big. */
export interface ReadResult {
  files: File[];
  skipped: string[];
}

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
 * Turns the plugin's base64 payload into a `File`.
 *
 * Reading the bytes through `fetch(convertFileSrc(path))` would stream them
 * rather than holding the whole file in JS memory, but it cannot work in the
 * cloud shells: `server.url` carries a path (`.../assistant`), the file URL is
 * served from the custom scheme, and the asset handler answers that
 * cross-origin request with an `Access-Control-Allow-Origin` built from the
 * full server URL. An origin never has a path, so the value can never match
 * and every read is refused. Base64 costs memory on a large video and is the
 * only path that works for every file.
 */
function fileFromBase64(data: string, name: string, mimeType: string): File {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], name, { type: mimeType });
}

interface PickedFile {
  blob?: Blob;
  data?: string;
  path?: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Mirrors the ceiling `composer-store` already enforces, so a pick too large
 * to attach is refused before its bytes move rather than after. The store's
 * own rule is not a flat cap: an auto-resizable image is allowed a larger
 * source because it gets downscaled on the way up.
 */
function isWithinAttachmentLimit(file: PickedFile): boolean {
  if (file.size <= MAX_ATTACHMENT_BYTES) {
    return true;
  }
  return (
    isAutoResizableImage({ name: file.name, type: file.mimeType }) &&
    file.size <= IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES
  );
}

/**
 * Reads the picked entries into `File`s, skipping any the composer would
 * refuse anyway.
 *
 * Neither pick asks for the data up front. The plugin's own note on that
 * option is that reading large files can crash the app, and both pickers
 * default to an unlimited selection, so requesting it eagerly would
 * base64-encode a whole video (or a whole multi-select) across the bridge
 * before anything checked whether it could be attached at all. The size comes
 * back with the pick, so the check happens first and only the entries that
 * pass are read.
 *
 * Sequential rather than `Promise.all`: reading is the expensive step, and one
 * at a time holds peak memory to a single file instead of the whole selection.
 */
async function readPicked(picked: PickedFile[]): Promise<ReadResult> {
  const files: File[] = [];
  const skipped: string[] = [];

  for (const file of picked) {
    // The web implementation hands back a Blob directly, already in memory and
    // carrying no path to read from.
    if (file.blob) {
      files.push(new File([file.blob], file.name, { type: file.mimeType }));
      continue;
    }
    if (!isWithinAttachmentLimit(file)) {
      skipped.push(file.name);
      continue;
    }
    if (!file.path) {
      continue;
    }
    const { Filesystem } = await import("@capacitor/filesystem");
    const { data } = await Filesystem.readFile({ path: file.path });
    // A zero-byte file reads back as an empty string, which is a valid payload
    // and not a missing one.
    if (typeof data === "string") {
      files.push(fileFromBase64(data, file.name, file.mimeType));
    } else {
      files.push(new File([data], file.name, { type: file.mimeType }));
    }
  }

  return { files, skipped };
}

/**
 * Opens the system media picker, for images and video alike. `pickMedia`
 * rather than an images-only call: the file input this replaces accepted
 * `image/*,video/*`, and a row that silently dropped video would be a
 * narrower Photo Library than the one it replaces.
 */
export async function pickMediaNative(): Promise<ReadResult> {
  // Destructured inline, never held at module scope or returned from an async
  // function: a plugin is a Proxy that synthesizes `.then`, so letting one
  // reach a Promise-resolution context dispatches `then()` natively and hangs
  // the await for good. See `docs/CAPACITOR.md`.
  const { FilePicker } = await import("@capawesome/capacitor-file-picker");
  const { files } = await FilePicker.pickMedia();
  return readPicked(files);
}

/** Opens the system document picker. */
export async function pickFilesNative(): Promise<ReadResult> {
  const { FilePicker } = await import("@capawesome/capacitor-file-picker");
  const { files } = await FilePicker.pickFiles();
  return readPicked(files);
}
