import { toast } from "@vellumai/design-library";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
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
import { hideNativeKeyboard } from "@/runtime/native-keyboard";
import { isNativeIOS } from "@/runtime/platform-detection";

// Loaded only when the iOS camera row opens. A static import pulls the voice
// camera module into every composer test, including ones whose platform mock
// does not cover that graph.
const QuietCameraOverlay = lazy(() =>
  import("@/domains/chat/components/chat-attachments/camera-capture-overlay").then(
    (mod) => ({ default: mod.CameraCaptureOverlay }),
  ),
);

const RESTORE_FOCUS = { alwaysRestoreFocus: true } as const;

/** Thrown to abandon a native pick whose sheet is no longer on screen. */
class PickAbandoned extends Error {
  constructor() {
    super("The pick's surface unmounted before it finished.");
    this.name = "PickAbandoned";
  }
}

export function useComposerAttachmentPickers({
  onOpenChange,
  onAttachFiles,
}: {
  onOpenChange: (open: boolean) => void;
  onAttachFiles: (files: FileList | File[]) => File[] | void;
}) {
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

  const closeThenPick = (openPicker: () => void) => () => {
    onOpenChange(false);
    openPicker();
  };

  // iOS camera is the app viewfinder, not `<input capture>`. The system camera
  // records audio for a still photo and moves Bluetooth onto the headset
  // profile. The overlay asks for video only. Loaded lazily so a shell that
  // never opens it does not pay for the camera module.
  const [cameraOpen, setCameraOpen] = useState(false);
  const openQuietCamera = useCallback(() => {
    onOpenChange(false);
    void hideNativeKeyboard();
    setCameraOpen(true);
  }, [onOpenChange]);

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
          // Restore focus only while the owning composer is mounted.
          if (mountedRef.current) {
            requestComposerFocus();
          }
        }
      },
    [attachPickedFile, onOpenChange, t],
  );

  // Read once per render rather than per row, and deliberately not a hook:
  // neither the shell a session runs in nor the plugins its build links can
  // change mid-session, and the sheet is already mounted for the session by
  // the time a row can be tapped. False on a shell whose runtime registers no
  // such plugin, where the rows use the file input rather than doing nothing.
  const native = nativeAttachmentPickersAvailable();

  return {
    inputs: (
      <>
        <div className="relative h-0 w-0">
          {camera.inputNode}
          {gallery.inputNode}
          {files.inputNode}
        </div>
        {cameraOpen ? (
          <Suspense fallback={null}>
            <QuietCameraOverlay
              onCapture={(files) => {
                if (!mountedRef.current) {
                  return;
                }
                onAttachFilesRef.current(files);
              }}
              onClose={() => {
                setCameraOpen(false);
              }}
              // After the dialog releases focus. Unmounting the focused
              // surface moves focus to the document, and the dialog
              // restores focus on a later turn.
              onClosed={() => {
                if (mountedRef.current) {
                  requestComposerFocus();
                }
              }}
            />
          </Suspense>
        ) : null}
      </>
    ),
    camera: isNativeIOS() ? openQuietCamera : closeThenPick(camera.openPicker),
    photos: native
      ? closeThenPickNative(pickMediaNative)
      : closeThenPick(gallery.openPicker),
    files: native
      ? closeThenPickNative(pickFilesNative)
      : closeThenPick(files.openPicker),
  };
}
