
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";

interface UseChatAttachmentDropZoneOptions {
  /** Callback that receives regular (non-directory) files dropped on the zone. */
  onFiles: (files: File[]) => void;
  /**
   * Callback fired when directories are dropped. Directories are surfaced
   * separately from files because a browser can't read their contents — the
   * caller decides how to handle them (Electron: resolve the native path via
   * `webUtils.getPathForFile`; web: reject with a clear error).
   */
  onDirectories?: (directories: File[]) => void;
  /** When true, drops are ignored and no visual feedback is shown. */
  disabled?: boolean;
}

export interface ChatAttachmentDropZoneHandlers {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

interface UseChatAttachmentDropZoneResult {
  /** True while a drag containing files is hovering over the drop zone. */
  isDragOver: boolean;
  /** Event handlers to spread onto the element acting as the drop zone. */
  dropHandlers: ChatAttachmentDropZoneHandlers;
}

/**
 * Returns true when a DataTransfer contains at least one "Files" entry.
 *
 * Ignores drags that only carry text/urls/HTML (e.g. selecting text in another
 * tab), matching the macOS desktop app which only accepts file-backed drags.
 */
function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  const types = dataTransfer.types;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === "Files") {
      return true;
    }
  }
  return false;
}

interface ExtractedDrop {
  files: File[];
  directories: File[];
}

/**
 * Collects dropped files and directories. Prefers `DataTransferItemList` so we
 * can inspect each entry via `webkitGetAsEntry` and split directory drops out
 * of the plain-file stream — the browser hands directories back as zero-byte
 * `File` objects that would otherwise be queued as failed uploads. Falls back
 * to `DataTransfer.files` when items aren't exposed; the fallback can't
 * distinguish directories, so everything there is treated as a file.
 */
function extractDrop(dataTransfer: DataTransfer): ExtractedDrop {
  const files: File[] = [];
  const directories: File[] = [];
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      const getAsEntry = (
        item as DataTransferItem & {
          webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
        }
      ).webkitGetAsEntry;
      const entry = typeof getAsEntry === "function" ? getAsEntry.call(item) : null;
      if (entry?.isDirectory) {
        directories.push(file);
      } else {
        files.push(file);
      }
    }
    return { files, directories };
  }
  if (dataTransfer.files.length > 0) {
    for (let index = 0; index < dataTransfer.files.length; index += 1) {
      const file = dataTransfer.files.item(index);
      if (file) {
        files.push(file);
      }
    }
  }
  return { files, directories };
}

/**
 * Provides drop-zone handlers and drag-over state for attaching files by
 * dragging them into an element. Mirrors the macOS desktop app's composer
 * drop behavior: any file-backed drag is accepted and forwarded to the
 * attachment manager, which handles type/size validation downstream.
 */
export function useChatAttachmentDropZone({
  onFiles,
  onDirectories,
  disabled = false,
}: UseChatAttachmentDropZoneOptions): UseChatAttachmentDropZoneResult {
  const [isDragOver, setIsDragOver] = useState(false);
  // dragenter/dragleave fire for every descendant the pointer crosses, so we
  // keep a counter to know when the drag has actually left the zone.
  const dragDepthRef = useRef(0);

  const reset = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }, []);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (disabled) {
        return;
      }
      if (!dragHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      // React bails out on identical state, so no extra guard is needed; keeping
      // `isDragOver` out of the dep array avoids re-creating the handler on every
      // toggle and sidesteps stale-closure bugs if leave→enter fires before a
      // re-render.
      setIsDragOver(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (disabled) {
        return;
      }
      if (!dragHasFiles(event.dataTransfer)) {
        return;
      }
      // preventDefault is required in both dragenter and dragover for drop
      // to fire; dragover runs continuously so we set dropEffect here.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (disabled) {
        return;
      }
      if (!dragHasFiles(event.dataTransfer)) {
        return;
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragOver(false);
      }
    },
    [disabled],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (disabled) {
        return;
      }
      if (!dragHasFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      const { files, directories } = extractDrop(event.dataTransfer);
      reset();
      if (files.length > 0) {
        onFiles(files);
      }
      if (directories.length > 0) {
        onDirectories?.(directories);
      }
    },
    [disabled, onFiles, onDirectories, reset],
  );

  const dropHandlers = useMemo<ChatAttachmentDropZoneHandlers>(
    () => ({
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    }),
    [handleDragEnter, handleDragOver, handleDragLeave, handleDrop],
  );

  // Mask drag-over feedback when disabled so a lingering state from an
  // in-flight drag can't leave the overlay visible after the zone shuts off.
  return { isDragOver: isDragOver && !disabled, dropHandlers };
}
