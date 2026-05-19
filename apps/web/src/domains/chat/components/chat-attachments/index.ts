// TODO: port from platform
import type { DragEventHandler, ReactNode } from "react";

export type ChatAttachment =
  | { kind: "uploaded"; id: string; localId?: string; filename: string; mimeType: string; sizeBytes: number; previewUrl?: string | null; file?: File }
  | { kind: "pending"; id: string; localId?: string; filename: string; mimeType: string; sizeBytes: number; previewUrl?: string | null; file?: File };

export interface ChatAttachmentDropZoneHandlers {
  onDragEnter: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
}

export function AttachFileButton(_props: Record<string, unknown>): ReactNode { return null; }
export function ChatAttachmentsStrip(_props: Record<string, unknown>): ReactNode { return null; }
export function MessageAttachments(_props: Record<string, unknown>): ReactNode { return null; }
export function useChatAttachmentDropZone(_opts?: { onFiles?: (files: File[]) => void; disabled?: boolean }) {
  const noop: DragEventHandler<HTMLDivElement> = () => {};
  return {
    isDragOver: false,
    dropHandlers: { onDragEnter: noop, onDragOver: noop, onDragLeave: noop, onDrop: noop } as ChatAttachmentDropZoneHandlers,
    handlers: {} as Record<string, unknown>,
  };
}
