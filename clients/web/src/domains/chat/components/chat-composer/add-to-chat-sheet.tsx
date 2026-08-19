import { BottomSheet, toast } from "@vellumai/design-library";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  File as FileIcon,
  Image as ImageIcon,
  X,
  type LucideIcon,
} from "lucide-react";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import {
  isPickerDismissal,
  nativeAttachmentPickersAvailable,
  type OnPickedFile,
  pickFilesNative,
  pickMediaNative,
  type PickOutcome,
} from "@/domains/chat/components/chat-attachments/native-attachment-pickers";
import { captureError } from "@/lib/sentry/capture-error";
import { useAttachmentFilePicker } from "@/domains/chat/components/chat-attachments/use-attachment-file-picker";
import { useTranslation } from "@/i18n";

interface AddToChatRowProps {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
}

function AddToChatRow({ icon: Icon, label, onSelect }: AddToChatRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-[8px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-base)]"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--border-subtle)]">
        <Icon className="size-4 text-[var(--content-secondary)]" />
      </span>
      <span className="min-w-0 truncate text-body-large-default text-[var(--content-default)]">
        {label}
      </span>
    </button>
  );
}

/**
 * The sheet traps focus, so by the time a row launches a picker the composer
 * has already lost it and the picker's own open-time sample would read "no
 * keyboard owed". The rows opt out of that sample to keep returning the
 * keyboard they have always returned.
 */
const RESTORE_FOCUS = { alwaysRestoreFocus: true } as const;

/** Thrown to abandon a native pick whose sheet is no longer on screen. */
class PickAbandoned extends Error {
  constructor() {
    super("The pick's surface unmounted before it finished.");
    this.name = "PickAbandoned";
  }
}

interface AddToChatSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the files picked from any of the three rows. */
  /**
   * Takes the picked files and answers with the ones it kept, where it filters
   * at all. Returning nothing counts as keeping them, so a caller that does no
   * filtering stays a plain callback and cannot free an allowance by accident.
   */
  onAttachFiles: (files: FileList | File[]) => File[] | void;
  /**
   * Told whenever a picker this sheet launched goes up or comes down.
   *
   * The rows close the sheet before opening anything, and a picker takes the
   * web view's first responder, so from the composer's side both of its own
   * signals read idle for as long as a pick lasts. That is the whole of it on
   * a native pick, which resolves only once every selected file has been read
   * across the bridge: without this the composer spends those seconds
   * rearranged for an empty box behind the surface the user is picking in,
   * and snaps back as the picker dismisses.
   */
  onPickerOpenChange: (open: boolean) => void;
}

/**
 * Mobile "Add to chat" bottom sheet: Camera, Photo Library, and Files, each
 * backed by its own hidden `<input type="file">` in a browser.
 *
 * In the Capacitor shells the photo and document rows open the native pickers
 * instead, because WebKit answers a file input with its own action sheet and
 * neither surface is reachable through it (see `native-attachment-pickers`).
 * Camera keeps the input everywhere: `capture` already forces the camera
 * rather than that sheet.
 *
 * The three inputs render as siblings of `BottomSheet.Root`, outside the
 * dialog portal. A row tap closes the sheet before opening the native picker,
 * so an input mounted inside the sheet content would unmount while its picker
 * was still on screen and the selection would never reach `onAttachFiles`.
 * They sit in a zero-size positioned box because the hook lays each input out
 * as `absolute inset-0`, which would otherwise stretch across whichever
 * positioned ancestor the sheet happens to be mounted under.
 */
export function AddToChatSheet({
  open,
  onOpenChange,
  onAttachFiles,
  onPickerOpenChange,
}: AddToChatSheetProps) {
  const { t } = useTranslation("chat");
  const camera = useAttachmentFilePicker({
    onFiles: onAttachFiles,
    accept: "image/*",
    capture: "environment",
    ...RESTORE_FOCUS,
  });
  const gallery = useAttachmentFilePicker({
    onFiles: onAttachFiles,
    accept: "image/*,video/*",
    multiple: true,
    ...RESTORE_FOCUS,
  });
  const files = useAttachmentFilePicker({
    onFiles: onAttachFiles,
    multiple: true,
    ...RESTORE_FOCUS,
  });

  // Read through a ref for the same reason `useAttachmentFilePicker` does:
  // a pick outlives the render that started it, and this callback carries the
  // assistant the files are queued against and the vision support they are
  // filtered by. A native pick settles only once every file has been read
  // across the bridge, so a model or assistant that changes in between would
  // otherwise send the rest of the selection where it no longer belongs.
  const onAttachFilesRef = useRef(onAttachFiles);
  useEffect(() => {
    onAttachFilesRef.current = onAttachFiles;
  }, [onAttachFiles]);

  // The ref covers a callback that changes under a mounted sheet. It cannot
  // cover one that stops arriving: `ChatPage` swaps the whole active view out
  // for a connecting state, so an assistant switch or a transport blip takes
  // this sheet with it and freezes the ref on the way. Delivery after that
  // point would queue against the assistant the user has left.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Hands one picked file over and answers whether it was kept.
   *
   * Only an explicit empty answer frees the allowance. A caller that says
   * nothing is taken to have kept the file, which is the safe direction:
   * silence cannot uncap the budget.
   *
   * Throwing once the sheet is gone rather than returning is what stops the
   * rest of a selection being read for nobody: `readPicked` abandons its loop
   * on a throw and sweeps every temporary copy the picker made on the way out,
   * which is the same path a failed read already takes.
   */
  const attachPickedFile = useCallback((file: File): boolean => {
    if (!mountedRef.current) {
      throw new PickAbandoned();
    }
    const kept = onAttachFilesRef.current([file]);
    return kept === undefined || kept.length > 0;
  }, []);

  // A native pick has no element behind it to watch, so its span is held
  // here. The input rows carry their own, which is what `pickerUp` folds in.
  const [nativePickInFlight, setNativePickInFlight] = useState(false);

  const closeThenPick = (openPicker: () => void) => () => {
    onOpenChange(false);
    openPicker();
  };

  /**
   * The shells' photo and document rows, which open a native surface instead
   * of an `<input type="file">`.
   *
   * `useAttachmentFilePicker` restores composer focus from the input's own
   * `change` / `cancel` / window-`focus` events, none of which a native picker
   * fires. Without the explicit call here the picker would work and the
   * keyboard would not come back, so every path out of this promise refocuses:
   * a selection, an empty return, and the rejection the plugins raise on
   * cancel alike.
   */
  const closeThenPickNative = useCallback(
    (pick: (onFile: OnPickedFile) => Promise<PickOutcome>) =>
      async (): Promise<void> => {
        onOpenChange(false);
        setNativePickInFlight(true);
        try {
          // Handed on one at a time rather than collected: the picker reads the
          // next file only after this one has left it, so a multi-select never
          // sits decoded in the picker all at once.
          const { tooLarge, pickFull } = await pick(attachPickedFile);
          if (!mountedRef.current) {
            return;
          }
          // Refused by the picker, so the composer never sees them and cannot
          // report them itself. The two reasons are told apart because a file
          // turned away for the company it was picked with attaches fine on its
          // own, and "too large" would send the user off shrinking it for
          // nothing.
          if (tooLarge.length > 0) {
            toast.error(
              t("addToChatSheet.tooLarge", { count: tooLarge.length }),
            );
          }
          if (pickFull.length > 0) {
            toast.error(
              t("addToChatSheet.pickFull", { count: pickFull.length }),
            );
          }
        } catch (error) {
          // A dismissal is a rejection too, and not worth reporting: the user
          // closed a sheet they opened. An abandoned pick is the same in kind,
          // raised here rather than by the picker. Anything else is a real
          // failure (an iOS temporary-copy or unsupported-type error, an Android
          // picker fault, a failed read) and would otherwise look identical to
          // picking nothing, so it is reported and shown.
          if (error instanceof PickAbandoned || !mountedRef.current) {
            return;
          }
          if (!isPickerDismissal(error)) {
            captureError(error, { context: "add_to_chat_sheet_native_picker" });
            toast.error(t("addToChatSheet.pickFailed"));
          }
        } finally {
          // Both are owed to a sheet that is still standing. A departed one has
          // no keyboard to take back and no row left to hold up.
          if (mountedRef.current) {
            requestComposerFocus();
            setNativePickInFlight(false);
          }
        }
      },
    [attachPickedFile, onOpenChange, t],
  );

  const pickerUp =
    nativePickInFlight ||
    camera.pickerOpen ||
    gallery.pickerOpen ||
    files.pickerOpen;
  useEffect(() => {
    onPickerOpenChange(pickerUp);
    // A sheet unmounted mid-pick would otherwise leave the composer holding a
    // picker that is no longer there.
    return () => {
      if (pickerUp) {
        onPickerOpenChange(false);
      }
    };
  }, [onPickerOpenChange, pickerUp]);

  // Read once per render rather than per row, and deliberately not a hook:
  // neither the shell a session runs in nor the plugins its build links can
  // change mid-session, and the sheet is already mounted for the session by
  // the time a row can be tapped. False on a shell whose runtime registers no
  // such plugin, where the rows use the file input rather than doing nothing.
  const native = nativeAttachmentPickersAvailable();

  return (
    <>
      <div className="relative h-0 w-0">
        {camera.inputNode}
        {gallery.inputNode}
        {files.inputNode}
      </div>
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Content
          aria-describedby={undefined}
          padded={false}
          // Three rows and a header already read as a sheet, so it hugs its
          // content instead of the primitive's default floor.
          className="min-h-0 pt-2 pb-[calc(8px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
        >
          <span
            aria-hidden="true"
            className="mx-auto h-1 w-14 shrink-0 rounded-full bg-[var(--border-element)]"
          />
          <BottomSheet.Header className="flex-row items-center justify-between gap-2 px-4 pt-3 pb-2">
            <BottomSheet.Title className="text-body-large-default text-[var(--content-tertiary)]">
              {t("addToChatSheet.title")}
            </BottomSheet.Title>
            {/* `-m-2 p-2` grows the tap target without moving the glyph. */}
            <BottomSheet.Close
              aria-label={t("addToChatSheet.closeAriaLabel")}
              className="-m-2 flex shrink-0 items-center justify-center p-2 text-[var(--content-tertiary)]"
            >
              <X className="size-4" />
            </BottomSheet.Close>
          </BottomSheet.Header>
          <BottomSheet.Body className="flex flex-col gap-4 px-4 pt-3 pb-4">
            <AddToChatRow
              icon={Camera}
              label={t("addToChatSheet.camera")}
              onSelect={closeThenPick(camera.openPicker)}
            />
            <AddToChatRow
              icon={ImageIcon}
              label={t("addToChatSheet.gallery")}
              onSelect={
                native
                  ? closeThenPickNative(pickMediaNative)
                  : closeThenPick(gallery.openPicker)
              }
            />
            <AddToChatRow
              icon={FileIcon}
              label={t("addToChatSheet.files")}
              onSelect={
                native
                  ? closeThenPickNative(pickFilesNative)
                  : closeThenPick(files.openPicker)
              }
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    </>
  );
}
