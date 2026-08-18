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

import { IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import { canQueueFile } from "@/domains/chat/composer-store";
import { isNativeIOS, isNativeMobile } from "@/runtime/platform-detection";

/** Names of any entries refused without being read. */
export interface PickOutcome {
  skipped: string[];
}

/** Receives each file as it is read, before the next one is. */
export type OnPickedFile = (file: File) => void;

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
 *
 * It also pins the rest of the runtime. A shell that registers this plugin
 * was built from a manifest that carries it, and that manifest carries a
 * `@capacitor/filesystem` new enough to read a byte range, which is what
 * `readFileParts` relies on.
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
 * Turns one of the plugin's base64 payloads into bytes.
 *
 * Reading the bytes through `fetch(convertFileSrc(path))` would stream them
 * rather than holding them in JS memory at all, but it cannot work in the
 * cloud shells: `server.url` carries a path (`.../assistant`), the file URL is
 * served from the custom scheme, and the asset handler answers that
 * cross-origin request with an `Access-Control-Allow-Origin` built from the
 * full server URL. An origin never has a path, so the value can never match
 * and every read is refused. Base64 costs memory and is the only path that
 * works for every file.
 */
function bytesFromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * The most one bridge call carries.
 *
 * Asking for a whole file at once costs several times its size in transient
 * memory: the base64 the bridge serialises, the binary string `atob` returns,
 * the `Uint8Array` built from that and the `File`'s own copy are all live
 * together, so a 100 MB image the store happily accepts peaks far past what a
 * phone web view survives. Reading a slice at a time leaves only one slice of
 * that overhead outstanding. The assembled parts are the one copy that has to
 * exist for a `File` to be handed on at all.
 */
export const READ_SLICE_BYTES = 4 * 1024 * 1024;

/**
 * Reads a file into its parts, a slice at a time.
 *
 * The size bounds the loop and the length of what comes back ends it: any
 * answer other than a full slice is the last one. Short or empty means the
 * file ran out, which is also how a zero-byte file reads. Longer means the
 * runtime ignored the range and answered with the whole file, which is a
 * complete read and needs no second call.
 */
async function readFileParts(path: string, size: number): Promise<BlobPart[]> {
  const { Filesystem } = await import("@capacitor/filesystem");
  const parts: BlobPart[] = [];
  for (let offset = 0; offset < size; offset += READ_SLICE_BYTES) {
    const { data } = await Filesystem.readFile({
      path,
      offset,
      length: READ_SLICE_BYTES,
    });
    // Only the web implementation answers with a Blob, and its picks carry one
    // of their own without ever reaching a path to read.
    if (typeof data !== "string") {
      parts.push(data);
      break;
    }
    const bytes = bytesFromBase64(data);
    parts.push(bytes);
    if (bytes.length !== READ_SLICE_BYTES) {
      break;
    }
  }
  return parts;
}

interface PickedFile {
  blob?: Blob;
  data?: string;
  path?: string;
  name: string;
  mimeType: string | null;
  size: number;
}

/**
 * The size to judge an entry by.
 *
 * The plugin's own number is trusted only when it is non-zero. On Android
 * `getSizeFromUri` starts at `0` and returns that whenever the provider does
 * not publish `OpenableColumns.SIZE`, so zero means "empty" and "no idea"
 * alike, and reading a cloud-backed document on the strength of it is exactly
 * the crash this check exists to avoid. A stat tells the two apart: a genuinely
 * empty file stats at zero and still attaches.
 */
async function resolveSize(file: PickedFile): Promise<number | null> {
  if (file.size > 0) {
    return file.size;
  }
  if (!file.path) {
    return file.size;
  }
  const { Filesystem } = await import("@capacitor/filesystem");
  try {
    const { size } = await Filesystem.stat({ path: file.path });
    return size;
  } catch {
    // Still unknown, so it stays unread. Refusing an empty file whose stat
    // failed costs an attachment; reading a file of unknown size costs the
    // web view.
    return null;
  }
}

/**
 * The most one pick may read in total.
 *
 * Per-file checks alone do not bound a multi-select: several files that each
 * pass still decode into memory together, since the composer holds every one
 * it has been handed while its upload runs. One pick may therefore bring in at
 * most what a single largest-allowed attachment could, which keeps the ceiling
 * anchored to a limit the app already has rather than a new invented one.
 */
const MAX_PICK_TOTAL_BYTES = IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES;

/**
 * The most one media pick may hand back.
 *
 * iOS copies every selected representation into the app's Caches before it
 * resolves, so an unlimited selection lets the picker write an unbounded
 * amount to disk before any check here can refuse a byte of it. This ceiling
 * is a plain choice rather than something derived from another limit: it sits
 * well above what a pick normally holds and far below what fills a sandbox.
 *
 * iOS media only. `PHPickerConfiguration.selectionLimit` takes the number as
 * given, while the document picker and both Android pickers read any non-zero
 * limit as single-select, so passing one there would cost multi-select rather
 * than bound it.
 */
const MAX_IOS_MEDIA_SELECTION = 10;

/**
 * Removes the copy iOS made for this pick.
 *
 * Both iOS delegates copy every selection into a fresh UUID directory under
 * the app's Caches before resolving, and the plugin never clears them up, so
 * a path handed back there belongs to us and nothing else reads it once the
 * bytes are in memory. Left alone they accumulate silently, and the entries
 * this module refuses without reading would stack up fastest of all.
 *
 * Android hands back a `content://` URI naming the provider's own document
 * rather than a copy, so those are left strictly alone.
 *
 * Best effort: a pick that has been read is already attached, and failing to
 * tidy afterwards is not worth losing it over.
 */
async function discardTemporaryCopy(path: string | undefined): Promise<void> {
  if (!path || path.startsWith("content://")) {
    return;
  }
  const { Filesystem } = await import("@capacitor/filesystem");
  try {
    await Filesystem.deleteFile({ path });
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

/**
 * Reads the picked entries, handing each one on before reading the next.
 *
 * Neither pick asks for the data up front. The plugin's own note on that
 * option is that reading large files can crash the app, and a document pick
 * takes an unlimited selection, so requesting it eagerly would base64-encode a
 * whole video, or a whole multi-select, across the bridge before anything
 * checked whether it could be attached at all.
 *
 * Delivering incrementally rather than collecting an array is what bounds
 * this: reading sequentially into a list still holds every decoded file at
 * once, so a handful of large-but-valid documents exhausts the web view just
 * as a single huge one would. Handing each file to the caller as it is read
 * leaves this module holding one at a time.
 */
async function readPicked(
  picked: PickedFile[],
  onFile: OnPickedFile,
): Promise<PickOutcome> {
  const skipped: string[] = [];
  // The copies this pick still owes a delete. A read that throws abandons the
  // loop, and every entry it never reached was copied by the picker just the
  // same, so the sweep at the end is what stops a failure leaving the rest of
  // a selection behind.
  const pending = new Set<string>();
  for (const file of picked) {
    if (file.path) {
      pending.add(file.path);
    }
  }
  let readSoFar = 0;

  try {
    for (const file of picked) {
      // An Android provider that publishes no type leaves this null, and the
      // resize check reads it as a string. Normalising once here keeps every
      // later use (the check, the `File`) working off the same value.
      const mimeType = file.mimeType ?? "";

      // The web implementation hands back a Blob directly, already in memory
      // and carrying no path to read from.
      if (file.blob) {
        onFile(new File([file.blob], file.name, { type: mimeType }));
        continue;
      }

      // Every way out of this entry drops the copy behind it, refusals
      // included: a file skipped for its size is one whose bytes were never
      // wanted, so leaving it on disk is the worst of both.
      try {
        const size = await resolveSize(file);
        if (
          size === null ||
          !canQueueFile({ name: file.name, type: mimeType, size })
        ) {
          skipped.push(file.name);
          continue;
        }
        if (readSoFar + size > MAX_PICK_TOTAL_BYTES) {
          skipped.push(file.name);
          continue;
        }
        if (!file.path) {
          continue;
        }
        const parts = await readFileParts(file.path, size);
        readSoFar += size;
        onFile(new File(parts, file.name, { type: mimeType }));
      } finally {
        if (file.path) {
          pending.delete(file.path);
        }
        await discardTemporaryCopy(file.path);
      }
    }
  } finally {
    for (const path of pending) {
      await discardTemporaryCopy(path);
    }
  }

  return { skipped };
}

/**
 * Opens the system media picker, for images and video alike.
 *
 * `pickMedia` rather than an images-only call because the row names a Photo
 * Library, which holds both, and the composer takes a video attachment as
 * readily as an image.
 */
export async function pickMediaNative(
  onFile: OnPickedFile,
): Promise<PickOutcome> {
  // Destructured inline, never held at module scope or returned from an async
  // function: a plugin is a Proxy that synthesizes `.then`, so letting one
  // reach a Promise-resolution context dispatches `then()` natively and hangs
  // the await for good. See `docs/CAPACITOR.md`.
  const { FilePicker } = await import("@capawesome/capacitor-file-picker");
  const { files } = await FilePicker.pickMedia(
    isNativeIOS() ? { limit: MAX_IOS_MEDIA_SELECTION } : undefined,
  );
  return readPicked(files, onFile);
}

/**
 * Opens the system document picker.
 *
 * No selection limit: every document picker here reads a non-zero limit as
 * single-select, so the only bound expressible would cost multi-select
 * outright. What `readPicked` refuses is the bound instead.
 */
export async function pickFilesNative(
  onFile: OnPickedFile,
): Promise<PickOutcome> {
  const { FilePicker } = await import("@capawesome/capacitor-file-picker");
  const { files } = await FilePicker.pickFiles();
  return readPicked(files, onFile);
}
