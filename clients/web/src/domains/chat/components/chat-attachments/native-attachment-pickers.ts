/**
 * Photo-library and document pickers for the Capacitor shells.
 *
 * What lets the composer show a sheet of its own. A hidden
 * `<input type="file">` cannot reach either surface: WebKit answers every
 * click with its own action sheet (Photo Library / Take Photo / Choose File)
 * and offers no way to skip or narrow it, so rows built on inputs can only
 * raise that same list a second time. `capture` is the one exception, which
 * is why the camera row stays an input and these two do not.
 *
 * `PHPickerViewController` and `UIDocumentPickerViewController` are what the
 * plugin reaches, which is also why neither row costs a permission prompt.
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

/** Why an entry never reached the composer. */
export type PickSkipReason = "tooLarge" | "pickFull";

/** Names of any entries refused, grouped by what refused them. */
export interface PickOutcome {
  /** Bigger on its own than the composer accepts. */
  tooLarge: string[];
  /** Within its own limit, but past what is left of this pick's allowance. */
  pickFull: string[];
}

/**
 * Receives each file as it is read, before the next one is, and answers
 * whether it kept it.
 *
 * The composer turns files away for reasons this module does not model, the
 * vision gate being the one that bites: with a non-vision model selected it
 * drops images and keeps the rest. Only what it keeps is held in memory, so
 * only what it keeps is worth counting against a pick's allowance.
 */
export type OnPickedFile = (file: File) => boolean;

/** Registered name of the native plugin backing both pickers. */
const FILE_PICKER_PLUGIN = "FilePicker";

/**
 * Whether this shell can actually reach the native pickers.
 *
 * The shells load the web app from a remote `server.url`, so one bundle runs
 * against every installed build, including builds whose native runtime has no
 * such plugin. There the calls reject as unimplemented, and a row wired
 * straight to them does nothing at all. `isPluginAvailable` reads what the
 * runtime actually registered, so a shell without it uses the file input and
 * a shell with it opens the native surface.
 *
 * It also pins the rest of the runtime. A shell that registers this plugin
 * was built from a manifest that carries it, and that manifest carries a
 * `@capacitor/filesystem` that reads a byte range, which is what
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
 * The bridge is the only way in. `fetch(convertFileSrc(path))` is what the
 * plugin's own documentation suggests, and it cannot work here: the shells
 * load the app over `https`, the converted URL carries a custom scheme, and
 * WebKit treats that as mixed content and blocks the request before CORS is
 * consulted at all. Only image and media elements are exempt, so an `<img>`
 * would load where a `fetch` is refused. A correct
 * `Access-Control-Allow-Origin` would not rescue it either, and the header
 * the asset handler sends is built from a `server.url` carrying a path, which
 * can never equal an origin.
 *
 * Nor would it buy what it appears to. A `fetch` body is accumulated whole in
 * memory before `blob()` hands it over, so the file exists there either way;
 * base64 costs the encoding on top. What keeps that bounded is reading in
 * slices, and the assembled blob is spooled to disk at rest whichever route
 * built it.
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

/** A file read in full, with the length it actually turned out to be. */
interface FileParts {
  parts: Blob[];
  bytes: number;
}

/**
 * Reads a file into its parts, a slice at a time, or refuses it.
 *
 * A reported size can refuse a file before this is called but never bounds
 * what it reads here. Sizes come from providers that may not publish one, so
 * treating a low number as the length would hand on a truncated file, and a
 * zero would hand on an empty one. What comes back ends the read instead: any
 * answer other than a full slice is the last one, whether the file ran out,
 * was empty to begin with, or the runtime ignored the range and answered with
 * all of it at once.
 *
 * `limit` is what bounds the read, judging the bytes actually in hand rather
 * than a number that may be wrong, and naming what refused them. A file that
 * outgrows what it is allowed is abandoned rather than truncated, which keeps
 * this to one slice of overhead even for a source that never ends.
 *
 * Each slice is handed straight to blob storage rather than collected as
 * arrays for the `File` to copy at the end. Holding the arrays would put the
 * whole file in script memory and then put it there a second time when the
 * `File` snapshotted them, so a large image cost twice its size on top of
 * whatever the resize path then decodes. Blobs cost one slice of script
 * memory at a time, and the assembled file lives where a file input's bytes
 * already live.
 */
async function readFileParts(
  path: string,
  limit: (bytesRead: number) => PickSkipReason | null,
): Promise<FileParts | { refused: PickSkipReason }> {
  const { Filesystem } = await import("@capacitor/filesystem");
  const parts: Blob[] = [];
  let bytes = 0;
  for (let offset = 0; ; offset += READ_SLICE_BYTES) {
    const { data } = await Filesystem.readFile({
      path,
      offset,
      length: READ_SLICE_BYTES,
    });
    // Only the web implementation answers with a Blob, and its picks carry one
    // of their own without ever reaching a path to read.
    const slice = typeof data === "string" ? bytesFromBase64(data) : data;
    const length = slice instanceof Blob ? slice.size : slice.length;
    bytes += length;
    const refused = limit(bytes);
    if (refused) {
      return { refused };
    }
    if (length > 0) {
      parts.push(slice instanceof Blob ? slice : new Blob([slice]));
    }
    if (length !== READ_SLICE_BYTES) {
      return { parts, bytes };
    }
  }
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
 * The size to judge an entry by, or null when nothing here knows it.
 *
 * The plugin's own number is trusted only when it is non-zero. On Android
 * `getSizeFromUri` starts at `0` and returns that whenever the provider does
 * not publish `OpenableColumns.SIZE`, so zero means "empty" and "no idea"
 * alike. A stat gets a second opinion, but it asks the same provider and can
 * answer zero for the same reason, so a zero from either is reported as
 * unknown rather than as an empty file.
 *
 * Nothing is lost by refusing to guess. A size is only ever an early refusal,
 * and an entry that has none is read under the same limits and judged on the
 * bytes that arrive, so a genuinely empty file still attaches and a large one
 * is still turned away.
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
    return size > 0 ? size : null;
  } catch {
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
 * resolves, so an unlimited selection lets the picker write to disk without
 * any check here refusing a byte of it. This ceiling is a plain choice rather
 * than something derived from another limit: it sits well above what a pick
 * normally holds and far below what fills a sandbox.
 *
 * It bounds the count and not the bytes, which is as far as this layer
 * reaches. The plugin takes a selection limit and nothing about size, and it
 * loads each selection to a temporary file and copies that into a directory
 * of its own before resolving, so a handful of large videos still land twice
 * over in full before any limit below sees them. Bounding that would take a
 * budget in the copy itself, which is the plugin's to offer.
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
  const tooLarge: string[] = [];
  const pickFull: string[] = [];
  const refuse = (name: string, reason: PickSkipReason): void => {
    (reason === "tooLarge" ? tooLarge : pickFull).push(name);
  };
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

      // The two limits an entry has to clear, asked of a reported size before
      // any read and of the bytes in hand during one. Each names what turned
      // the file away, because being bigger than the composer takes and being
      // the last of a pick that has spent its allowance are different things
      // to be told.
      const allowance = (bytes: number): PickSkipReason | null => {
        if (!canQueueFile({ name: file.name, type: mimeType, size: bytes })) {
          return "tooLarge";
        }
        if (readSoFar + bytes > MAX_PICK_TOTAL_BYTES) {
          return "pickFull";
        }
        return null;
      };

      // Every way out of this entry drops the copy behind it, refusals
      // included: a file skipped for its size is one whose bytes were never
      // wanted, so leaving it on disk is the worst of both.
      try {
        // A known size refuses an entry without reading a byte of it. An
        // unknown one cannot refuse anything, so the read below applies the
        // same two limits to the bytes as they arrive and gives up on a file
        // that outgrows them.
        const size = await resolveSize(file);
        const refusedOnSize = size === null ? null : allowance(size);
        if (refusedOnSize) {
          refuse(file.name, refusedOnSize);
          continue;
        }
        if (!file.path) {
          continue;
        }
        const read = await readFileParts(file.path, allowance);
        if ("refused" in read) {
          refuse(file.name, read.refused);
          continue;
        }
        // Charged only if the composer kept it, and then for the bytes that
        // arrived rather than the size that was claimed. The allowance bounds
        // what a pick holds, and what it holds is this file, so a claim on
        // either side of the truth would spend the wrong number: one below it
        // lets a pick run past the ceiling, one above it turns away a later
        // file that would have fit.
        const kept = onFile(
          new File(read.parts, file.name, { type: mimeType }),
        );
        if (kept) {
          readSoFar += read.bytes;
        }
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

  return { tooLarge, pickFull };
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
