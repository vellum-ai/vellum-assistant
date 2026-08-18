import { BottomSheet } from "@vellumai/design-library";
import {
  Camera,
  File as FileIcon,
  Image as ImageIcon,
  X,
  type LucideIcon,
} from "lucide-react";

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

interface AddToChatSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the files picked from any of the three rows. */
  onAttachFiles: (files: FileList) => void;
}

/**
 * Mobile "Add to chat" bottom sheet: Camera, Photo Library, and Files, each
 * backed by its own hidden `<input type="file">`.
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
}: AddToChatSheetProps) {
  const { t } = useTranslation("chat");
  const camera = useAttachmentFilePicker({
    onFiles: onAttachFiles,
    accept: "image/*",
    capture: "environment",
  });
  const gallery = useAttachmentFilePicker({
    onFiles: onAttachFiles,
    accept: "image/*,video/*",
    multiple: true,
  });
  const files = useAttachmentFilePicker({
    onFiles: onAttachFiles,
    multiple: true,
  });

  const closeThenPick = (openPicker: () => void) => () => {
    onOpenChange(false);
    openPicker();
  };

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
              onSelect={closeThenPick(gallery.openPicker)}
            />
            <AddToChatRow
              icon={FileIcon}
              label={t("addToChatSheet.files")}
              onSelect={closeThenPick(files.openPicker)}
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    </>
  );
}
