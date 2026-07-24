import {
  ArrowDownToLine,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Video,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

/** A `vellum://` file link the user clicked, pending an action choice. */
export interface VellumFileActionTarget {
  /** Decoded display filename (resolved via the shared attachment-naming rule). */
  filename: string;
  /**
   * Workspace-relative path when the file lives in the assistant workspace.
   * Absent for `vellum://host/` links, which cannot open in the workspace
   * browser — the modal then offers download only.
   */
  workspacePath?: string;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "heic",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi"]);

function iconForFilename(filename: string): LucideIcon {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(extension)) {
    return ImageIcon;
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return Video;
  }
  return FileText;
}

/**
 * Action chooser shown when a `vellum://` file link is clicked in chat:
 * "Go to file" opens the file in the workspace browser (workspace files
 * only), "Download file" saves it locally.
 */
export function VellumFileActionModal({
  target,
  onGoToFile,
  onDownload,
  onClose,
}: {
  target: VellumFileActionTarget | null;
  onGoToFile: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  // Mounted only while a link click is pending an action choice — the
  // transcript renders one instance per message row, so an always-mounted
  // dialog would add per-row Radix overhead for a modal that is almost
  // never open.
  if (target == null) {
    return null;
  }
  return (
    <Modal.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title icon={iconForFilename(target.filename)}>
            {target.filename}
          </Modal.Title>
          {target.workspacePath ? (
            <Modal.Description className="truncate font-mono">
              {target.workspacePath}
            </Modal.Description>
          ) : null}
        </Modal.Header>
        <Modal.Footer>
          {target.workspacePath ? (
            <Button variant="outlined" onClick={onGoToFile}>
              <ExternalLink aria-hidden className="h-4 w-4" />
              Go to file
            </Button>
          ) : null}
          <Button variant="primary" onClick={onDownload}>
            <ArrowDownToLine aria-hidden className="h-4 w-4" />
            Download file
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
